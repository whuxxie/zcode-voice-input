/**
 * 火山引擎豆包流式语音识别 2.0 WebSocket 客户端（全双工）。
 *
 * 端点:
 *  - sentence 模式(默认, 分句识别): wss://openspeech.bytedance.com/api/v3/sauc/bigmodel_async
 *      request.enable_nonstream = true（二遍识别, 结束后得到更稳的整句结果）
 *  - realtime 模式(可选, 双向实时流式): wss://openspeech.bytedance.com/api/v3/sauc/bigmodel
 *
 * 鉴权(按控制台版本二选一):
 *  - 旧控制台: X-Api-App-Key: <AppID>  +  X-Api-Access-Key: <AccessToken>
 *  - 新控制台: X-Api-Key: <API Key>
 *  - X-Api-Resource-Id: volc.seedasr.sauc.duration(2.0 小时版) / volc.seedasr.sauc.concurrent(2.0 并发版)
 */
import { EventEmitter } from "node:events";
import crypto from "node:crypto";
import WebSocket from "ws";
import {
  encodeFullClientRequest,
  encodeAudioRequest,
  tryParseServerFrame,
  parseAsrResult,
  MESSAGE_TYPE,
  MESSAGE_TYPE_FLAGS,
} from "./volc-protocol.mjs";

const BASE_URL = "wss://openspeech.bytedance.com/api/v3/sauc";

export const ASR_MODES = {
  sentence: {
    endpoint: `${BASE_URL}/bigmodel_async`,
    enableNonstream: true,
  },
  realtime: {
    endpoint: `${BASE_URL}/bigmodel`,
    enableNonstream: false,
  },
};

export class VolcanoAsrError extends Error {
  constructor(message, { code = "ASR_ERROR", httpStatus = null, retryable = false } = {}) {
    super(message);
    this.name = "VolcanoAsrError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

function newRequestId() {
  return crypto.randomUUID();
}

/**
 * 单次识别会话。生命周期:
 *   start() → open 事件 → sendAudio()×N（isLast=true 结束）→ final 事件 / error 事件 → close
 *   或 cancel() 直接终止。
 *
 * 事件:
 *   open            连接与开始包就绪
 *   partial  {text, utterances, durationMs}   中间（及分句 definite）结果
 *   final    {text, utterances, durationMs}   稳定最终结果
 *   error    {Error}                          失败（final 之后不再触发）
 *   close    {reason}
 */
export class VolcanoAsrSession extends EventEmitter {
  /**
   * @param {object} opts
   * @param {"sentence"|"realtime"} [opts.mode]            默认 sentence
   * @param {string} [opts.appId]        旧控制台 AppID
   * @param {string} [opts.accessToken]  旧控制台 AccessToken
   * @param {string} [opts.apiKey]       新控制台 API Key
   * @param {string} [opts.resourceId]   默认 volc.seedasr.sauc.duration
   * @param {string} [opts.uid]
   * @param {Array<{word: string, weight?: number}>} [opts.hotwords]  热词（100 token 预算内）
   * @param {number} [opts.connectTimeoutMs]  默认 10000
   * @param {number} [opts.firstResultTimeoutMs] 默认 12000
   * @param {number} [opts.idleTimeoutMs]     默认 20000（流中无任何服务端帧）
   * @param {number} [opts.finalTimeoutMs]    默认 30000（发完最后一包等 final）
   * @param {number} [opts.connectRetries]    默认 2（仅网络类错误、未发音频时可重试）
   * @param {string} [opts.vadSegmentDurationMs] 默认 800
   */
  constructor(opts = {}) {
    super();
    this.mode = opts.mode === "realtime" ? "realtime" : "sentence";
    this.appId = opts.appId || "";
    this.accessToken = opts.accessToken || "";
    this.apiKey = opts.apiKey || "";
    this.resourceId = opts.resourceId || "volc.seedasr.sauc.duration";
    this.uid = opts.uid || "zcode-voice-input";
    this.hotwords = Array.isArray(opts.hotwords) ? opts.hotwords : [];
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10000;
    this.firstResultTimeoutMs = opts.firstResultTimeoutMs ?? 12000;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 20000;
    this.finalTimeoutMs = opts.finalTimeoutMs ?? 30000;
    this.connectRetries = opts.connectRetries ?? 2;
    this.vadSegmentDurationMs = opts.vadSegmentDurationMs ?? 800;

    this.endpoint = ASR_MODES[this.mode].endpoint;
    this.enableNonstream = ASR_MODES[this.mode].enableNonstream;

    this.ws = null;
    this.requestId = newRequestId();
    this.audioSent = false;
    this.finished = false; // final 已发或 error 已发
    this.cancelled = false;
    this._timers = new Set();
    this._recvBuf = Buffer.alloc(0);
    this._lastText = "";
    this._definiteTexts = [];
    this._finalResolved = null; // 延迟: final 到达时 resolve
    this._finalRejected = null;
  }

  /** 等待最终结果（finish 成功后的 Promise 版接口）。 */
  get done() {
    if (!this._donePromise) {
      this._donePromise = new Promise((resolve, reject) => {
        this._finalResolved = resolve;
        this._finalRejected = reject;
      });
    }
    return this._donePromise;
  }

  _armTimer(ms, kind) {
    const t = setTimeout(() => this._fail(new VolcanoAsrError(`${kind} timed out after ${ms}ms`, { code: "TIMEOUT", retryable: !this.audioSent })), ms);
    t.unref?.();
    this._timers.set(kind, t);
    return t;
  }
  _disarmTimer(kind) {
    const t = this._timers.get(kind);
    if (t) { clearTimeout(t); this._timers.delete(kind); }
  }

  buildAuthHeaders() {
    const headers = {
      "X-Api-Resource-Id": this.resourceId,
      "X-Api-Request-Id": this.requestId,
      "X-Api-Connect-Id": crypto.randomUUID(),
      "User-Agent": "zcode-voice-input/0.1.0",
    };
    if (this.apiKey) {
      headers["X-Api-Key"] = this.apiKey;
    } else if (this.appId && this.accessToken) {
      headers["X-Api-App-Key"] = this.appId;
      headers["X-Api-Access-Key"] = this.accessToken;
    } else {
      throw new VolcanoAsrError("missing credentials: need apiKey (new console) or appId+accessToken (legacy console)", { code: "NO_CREDENTIALS" });
    }
    return headers;
  }

  buildStartPayload() {
    const request = {
      model_name: "bigmodel",
      enable_punc: true,
      enable_itn: true,
      enable_ddc: false,
      enable_nonstream: this.enableNonstream,
      show_utterances: true,
      result_type: "full",
      vad_segment_duration: this.vadSegmentDurationMs,
      end_window_size: 800,
    };
    if (this.hotwords.length > 0) {
      // 热词直传：corpus.context 为 JSON 字符串（官方规约）。
      request.corpus = {
        context: JSON.stringify({ hotwords: this.hotwords.map((h) => (h.weight ? { word: h.word, weight: h.weight } : { word: h.word })) }),
      };
    }
    return {
      user: { uid: this.uid },
      audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1 },
      request,
    };
  }

  /** 建立连接并发送开始包。resolve 于 open；失败 reject（带 retryable 标记）。 */
  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const attempt = (triesLeft) => {
        const ws = new WebSocket(this.endpoint, { headers: this.buildAuthHeaders(), handshakeTimeout: this.connectTimeoutMs });
        this.ws = ws;
        this._armTimer(this.connectTimeoutMs, "connect");

        const onFail = (err, httpStatus) => {
          if (settled || this.finished || this.cancelled) { try { ws.close(); } catch {} return; }
          this._disarmTimer("connect");
          const retryable = !this.audioSent && triesLeft > 0 && (httpStatus == null || httpStatus >= 500 || httpStatus === 429) && !this.cancelled;
          if (retryable) {
            const delay = 500 * (2 ** (this.connectRetries - triesLeft));
            setTimeout(() => attempt(triesLeft - 1), delay).unref?.();
            return;
          }
          settled = true;
          reject(new VolcanoAsrError(`connect failed: ${err.message}`, { code: httpStatus ? `HTTP_${httpStatus}` : "CONNECT_FAILED", httpStatus, retryable: false }));
        };

        ws.on("unexpected-response", (_req, res) => {
          const status = res.statusCode;
          let bodyText = "";
          res.on("data", (c) => { bodyText += c.toString("utf8"); });
          res.on("end", () => onFail(new Error(`unexpected HTTP ${status} ${bodyText.slice(0, 200)}`), status));
        });
        ws.on("error", (err) => onFail(err, err.status ?? null));
        ws.on("open", () => {
          this._disarmTimer("connect");
          try {
            ws.send(encodeFullClientRequest(this.buildStartPayload()));
          } catch (err) {
            settled = true;
            reject(new VolcanoAsrError(`start payload failed: ${err.message}`, { code: "START_FAILED" }));
            return;
          }
          this._armTimer(this.firstResultTimeoutMs, "first-result");
          this._armTimer(this.idleTimeoutMs, "idle");
          if (!settled) {
            settled = true;
            this._bindStreams();
            this.emit("open");
            resolve();
          }
        });
      };
      try {
        attempt(this.connectRetries);
      } catch (err) {
        reject(err);
      }
    });
  }

  _bindStreams() {
    const ws = this.ws;
    ws.on("message", (data, isBinary) => {
      if (!isBinary) return;
      try {
        this._recvBuf = Buffer.concat([this._recvBuf, Buffer.from(data)]);
        while (true) {
          const parsed = tryParseServerFrame(this._recvBuf);
          if (!parsed) break;
          this._recvBuf = this._recvBuf.subarray(parsed.consumed);
          this._handleFrame(parsed.frame);
        }
      } catch (err) {
        this._fail(new VolcanoAsrError(`frame parse failed: ${err.message}`, { code: "PROTOCOL" }));
      }
    });
    ws.on("close", (code, reason) => {
      const reasonText = reason?.toString?.() || "";
      if (!this.finished) {
        this._fail(new VolcanoAsrError(`connection closed before final result (code=${code}${reasonText ? ` ${reasonText}` : ""})`, { code: "CLOSED_EARLY", retryable: !this.audioSent }));
      } else {
        this.emit("close", { code, reason: reasonText });
      }
    });
    ws.on("error", (err) => {
      if (!this.finished) {
        this._fail(new VolcanoAsrError(`socket error: ${err.message}`, { code: "SOCKET", retryable: !this.audioSent }));
      }
    });
  }

  _handleFrame(frame) {
    this._disarmTimer("idle");
    this._armTimer(this.idleTimeoutMs, "idle");
    if (frame.messageType === MESSAGE_TYPE.ERROR_RESPONSE) {
      const msg = frame.json?.message || frame.json?.error || "server error";
      const code = frame.errorCode ?? 0;
      const retryable = code >= 55000000 || code === 45000081; // 服务端繁忙可重试；等待超时不重试
      this._fail(new VolcanoAsrError(`ASR error ${code}: ${msg}`, { code: `ASR_${code}`, retryable }));
      return;
    }
    if (frame.messageType !== MESSAGE_TYPE.FULL_SERVER_RESPONSE) return;

    this._disarmTimer("first-result");
    const parsedResult = parseAsrResult(frame.json);
    const isFinalFrame = frame.sequence === -1 || (frame.isLastPacket && (frame.sequence === -1 || frame.sequence == null)) || frame.flags === MESSAGE_TYPE_FLAGS.LAST_NEGATIVE_SEQUENCE;

    // 分句模式: definite 分句纳入累计; result.text（服务端累计文本）作为权威展示文本
    for (const u of parsedResult.utterances) {
      if (u.definite && u.text) {
        if (this._definiteTexts[this._definiteTexts.length - 1] !== u.text) this._definiteTexts.push(u.text);
      }
    }
    const merged = mergeRecognitionText(parsedResult.text, parsedResult.utterances);
    if (merged) this._lastText = merged;

    if (isFinalFrame) {
      this._disarmTimer("idle");
      this._disarmTimer("final-wait");
      this.finished = true;
      const finalText = mergeRecognitionText(parsedResult.text, parsedResult.utterances) || this._lastText;
      this.emit("final", { text: finalText, utterances: parsedResult.utterances, durationMs: parsedResult.durationMs });
      try { this.ws?.close(1000, "done"); } catch {}
      this._finalResolved?.({ text: finalText, utterances: parsedResult.utterances, durationMs: parsedResult.durationMs });
      this.emit("close", { code: 1000, reason: "final" });
      return;
    }
    // 非最终帧: partial（含 definite 分句的实时更新）
    this.emit("partial", { text: merged, utterances: parsedResult.utterances, durationMs: parsedResult.durationMs });
  }

  /**
   * 发送音频。isLast=true 表示最后一包（flags=0b10），随后等待 final。
   * @returns {Promise<void>} finish 后解析为 final 结果
   */
  sendAudio(pcmBytes, isLast = false) {
    if (this.finished || this.cancelled) throw new VolcanoAsrError("session already closed", { code: "CLOSED" });
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) throw new VolcanoAsrError("socket not open", { code: "NOT_OPEN" });
    this.audioSent = true;
    this._disarmTimer("first-result");
    this._armTimer(this.idleTimeoutMs, "idle");
    this.ws.send(encodeAudioRequest(pcmBytes, isLast));
    if (isLast) {
      this._armTimer(this.finalTimeoutMs, "final-wait");
      return this.done;
    }
    return Promise.resolve();
  }

  /** 用户取消：立即断开，不产生 final。 */
  cancel() {
    this.cancelled = true;
    this.finished = true;
    this._clearTimers();
    const err = new VolcanoAsrError("cancelled by user", { code: "CANCELLED" });
    try { this.ws?.close(4000, "client cancel"); } catch {}
    this.emit("close", { code: 4000, reason: "cancelled" });
    this._finalRejected?.(err);
  }

  _fail(err) {
    if (this.finished) return;
    this.finished = true;
    this._clearTimers();
    try { this.ws?.close(); } catch {}
    this.emit("error", err);
    this._finalRejected?.(err);
    this.emit("close", { code: -1, reason: err.message });
  }

  _clearTimers() {
    for (const t of this._timers.values()) clearTimeout(t);
    this._timers.clear();
  }
}

/**
 * 合并服务端累计文本与分句列表，避免重复拼接。
 * 优先信任服务端 result.text（累计全量）；若为空则回退到 definite 分句 + 尾部 indefinite。
 */
export function mergeRecognitionText(serverText, utterances) {
  if (serverText && serverText.trim()) return serverText;
  const parts = [];
  for (const u of utterances || []) {
    if (u.text) parts.push(u.text);
  }
  return parts.join("");
}
