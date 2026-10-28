// volcano-asr.js — 火山引擎豆包流式语音识别 2.0 客户端（Node >= 22, 使用全局 WebSocket）
// 鉴权（双控制台兼容，凭据仅在本进程内使用，不写日志）:
//   旧版控制台: X-Api-App-Key=<appId> + X-Api-Access-Key=<accessToken>
//   新版控制台: X-Api-Key=<apiKey>
// 资源: X-Api-Resource-Id: volc.seedasr.sauc.duration（豆包大模型流式语音识别 2.0·按时长）
//       （可选并发版 volc.seedasr.sauc.concurrent；1.0 为 volc.bigasr.sauc.*）
'use strict';

const crypto = require('node:crypto');
const {
  MESSAGE_TYPE,
  MSG_TYPE_FLAGS,
  SERIALIZATION,
  COMPRESSION,
  createFrameParser,
  parseResponseFrame,
  encodeJsonFrame,
  encodeAudioFrame,
  buildStartRequestPayload,
  gzipSync,
} = require('./volcano-protocol.js');

const DEFAULT_ENDPOINT = 'wss://openspeech.bytedance.com/api/v3/sauc/bigmodel';
const RESOURCE_ID_20_DURATION = 'volc.seedasr.sauc.duration';
const RESOURCE_ID_20_CONCURRENT = 'volc.seedasr.sauc.concurrent';
const RESOURCE_ID_10_DURATION = 'volc.bigasr.sauc.duration';
const RESOURCE_ID_10_CONCURRENT = 'volc.bigasr.sauc.concurrent';

function resourceIdFor(model, billing) {
  if (model === '1.0') return billing === 'concurrent' ? RESOURCE_ID_10_CONCURRENT : RESOURCE_ID_10_DURATION;
  return billing === 'concurrent' ? RESOURCE_ID_20_CONCURRENT : RESOURCE_ID_20_DURATION;
}

class AsrError extends Error {
  constructor(code, message, { retryable = false, httpStatus } = {}) {
    super(message);
    this.name = 'AsrError';
    this.code = code;
    this.retryable = retryable;
    this.httpStatus = httpStatus;
  }
}

/**
 * 创建一次识别会话。
 * 返回控制器: {sendAudio(pcmBuffer), stop(), cancel(), promise}
 * promise resolve: {text, utterances, durationMs}
 * promise reject: AsrError
 *
 * options:
 *  - credentials: {appId, accessToken, apiKey}（旧版/新版至少一种）
 *  - model: '2.0'（默认）| '1.0'; billing: 'duration'（默认）| 'concurrent'
 *  - endpoint; mode: 'sentence'（默认，双向流式实时出句）| 'nostream'
 *  - sampleRate=16000; uid; enablePunc=true; enableItn=true; enableDdc=false
 *  - hotwords=[]; boostingTableId; correctTableId
 *  - connectTimeoutMs=10000; idleTimeoutMs=20000; endTimeoutMs=8000
 *  - retries=1（仅对“建连失败/握手拒绝”重试；音频中途断流不可续传，不自动重试）
 *  - 音频帧不带序号（会话级 X-Api-Sequence: -1；实测带正序号会被 bigmodel 端点断连）
 *  - logger: {info,warn,error}（会脱敏）
 */
function createAsrSession(options) {
  const {
    credentials,
    model = '2.0',
    billing = 'duration',
    endpoint = DEFAULT_ENDPOINT,
    mode = 'sentence',
    sampleRate = 16000,
    uid = 'zcode-voice-input',
    enablePunc = true,
    enableItn = true,
    enableDdc = false,
    hotwords = [],
    boostingTableId,
    correctTableId,
    connectTimeoutMs = 10000,
    idleTimeoutMs = 20000,
    endTimeoutMs = 8000,
    retries = 1,
    logger = { info() {}, warn() {}, error() {} },
    webSocketFactory = defaultWebSocketFactory,
  } = options;

  if (!credentials || (!credentials.apiKey && !(credentials.appId && credentials.accessToken))) {
    return rejected(new AsrError('E_NO_CREDENTIALS', '缺少火山引擎凭据（需要 apiKey，或 appId+accessToken）'));
  }
  if (typeof WebSocket === 'undefined' && !webSocketFactory) {
    return rejected(new AsrError('E_NO_WEBSOCKET', '当前 Node 缺少全局 WebSocket，请使用 Node >= 22', { retryable: false }));
  }

  const resourceId = resourceIdFor(model, billing);
  const requestId = crypto.randomUUID();

  let resolveDone, rejectDone;
  const promise = new Promise((res, rej) => {
    resolveDone = res;
    rejectDone = rej;
  });

  let ws = null;
  let settled = false;
  let started = false;
  let finishedUpstream = false;
  let connectAttempts = 0;
  let lastResultText = '';
  const definiteUtterances = [];
  let durationMs = 0;
  let idleTimer = null;
  let connectTimer = null;
  let endTimer = null;
  let cancelled = false;

  const parser = createFrameParser();

  function settle(fn, value) {
    if (settled) return;
    settled = true;
    clearTimers();
    try {
      if (ws) {
        try {
          ws.close(1000, 'bye');
        } catch {}
        try {
          ws.terminate?.();
        } catch {}
        ws = null;
      }
    } finally {
      fn === 'resolve' ? resolveDone(value) : rejectDone(value);
    }
  }

  function clearTimers() {
    for (const t of [idleTimer, connectTimer, endTimer]) {
      if (t) clearTimeout(t);
    }
    idleTimer = connectTimer = endTimer = null;
  }
  function bumpIdle() {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      fail(new AsrError('E_IDLE_TIMEOUT', `识别服务超过 ${idleTimeoutMs}ms 无响应`, { retryable: true }));
    }, idleTimeoutMs);
  }

  function fail(err) {
    logger.error('[asr] 失败:', err.code || '', err.message);
    settle('reject', err);
  }

  function buildHeaders() {
    const h = {
      'X-Api-Resource-Id': resourceId,
      'X-Api-Request-Id': requestId,
      'X-Api-Sequence': '-1',
    };
    if (credentials.apiKey) {
      h['X-Api-Key'] = credentials.apiKey;
    } else {
      h['X-Api-App-Key'] = credentials.appId;
      h['X-Api-Access-Key'] = credentials.accessToken;
    }
    return h;
  }

  function connectOnce() {
    return new Promise((resolveConnect, rejectConnect) => {
      let ws2;
      try {
        ws2 = webSocketFactory(endpoint, { headers: buildHeaders() });
      } catch (e) {
        rejectConnect(new AsrError('E_CONNECT', `建立 WebSocket 失败: ${e.message}`, { retryable: true }));
        return;
      }
      ws = ws2;
      // undici 全局 WebSocket 默认 binaryType='blob'，消息以 Blob 到达（Buffer.from(Blob) 会抛
      // ERR_INVALID_ARG_TYPE）——必须切到 arraybuffer（测试桩 WebSocket 无此属性则跳过）
      if ('binaryType' in ws2) ws2.binaryType = 'arraybuffer';
      connectTimer = setTimeout(() => {
        try {
          ws2.terminate?.();
        } catch {}
        rejectConnect(new AsrError('E_CONNECT_TIMEOUT', `连接火山引擎超时(${connectTimeoutMs}ms)`, { retryable: true }));
      }, connectTimeoutMs);

      ws2.addEventListener('open', () => {
        clearTimeout(connectTimer);
        connectTimer = null;
        resolveConnect(ws2);
      });
      ws2.addEventListener('error', (ev) => {
        clearTimeout(connectTimer);
        connectTimer = null;
        const msg = ev && ev.message ? String(ev.message) : 'WebSocket 错误';
        rejectConnect(new AsrError('E_CONNECT', `连接失败: ${msg}`, { retryable: true }));
      });
    });
  }

  function sendStart() {
    const payload = buildStartRequestPayload({
      uid,
      sampleRate,
      mode,
      enablePunc,
      enableItn,
      enableDdc,
      hotwords,
      boostingTableId,
      correctTableId,
    });
    const frame = encodeJsonFrame(MESSAGE_TYPE.FULL_CLIENT_REQUEST, MSG_TYPE_FLAGS.NO_SEQ, payload);
    ws.send(frame);
  }

  function handleFrame(frame) {
    bumpIdle();
    let parsed;
    try {
      parsed = parseResponseFrame(frame);
    } catch (e) {
      logger.warn('[asr] 解析响应失败:', e.message);
      return;
    }
    if (parsed.messageType === MESSAGE_TYPE.ERROR_RESPONSE) {
      const retryable = parsed.errorCode === 55000031 || parsed.errorCode === 55000032;
      fail(
        new AsrError(`E_ASR_${parsed.errorCode}`, parsed.errorMessage || '识别服务返回错误', {
          retryable,
        })
      );
      return;
    }
    if (parsed.messageType !== MESSAGE_TYPE.FULL_SERVER_RESPONSE) return;
    const result = parsed.json && parsed.json.result;
    if (parsed.json && parsed.json.audio_info && Number.isFinite(parsed.json.audio_info.duration)) {
      durationMs = Math.max(durationMs, Number(parsed.json.audio_info.duration));
    }
    if (result && typeof result.text === 'string') {
      lastResultText = result.text;
    }
    if (result && Array.isArray(result.utterances)) {
      for (const u of result.utterances) {
        if (u && u.definite === true) {
          const key = `${u.start_time ?? ''}:${u.text ?? ''}`;
          if (!definiteUtterances.some((d) => d.key === key)) {
            definiteUtterances.push({ key, text: u.text ?? '', utterance: u });
          }
        }
      }
    }
    const payloadForUi = {
      text: lastResultText,
      definiteTexts: definiteUtterances.map((d) => d.text),
      isLast: !!parsed.isLast,
    };
    if (callbacks.onPartial && !parsed.isLast) callbacks.onPartial(payloadForUi);
    if (parsed.isLast) {
      const finalText =
        lastResultText ||
        definiteUtterances.map((d) => d.text).join('') ||
        '';
      settle('resolve', {
        text: finalText,
        utterances: definiteUtterances.map((d) => d.utterance),
        durationMs,
      });
    }
  }

  const callbacks = { onPartial: null };

  function attachSession(ws2) {
    parser.reset();
    ws2.addEventListener('message', async (ev) => {
      let data = ev.data;
      if (typeof data === 'string') data = Buffer.from(data, 'utf8');
      else if (data instanceof ArrayBuffer) data = Buffer.from(data);
      else if (ArrayBuffer.isView(data)) data = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      else if (data && typeof data.arrayBuffer === 'function') {
        // 兜底：未设 binaryType 的 Blob 消息（异步取回，保持处理顺序）
        data = Buffer.from(await data.arrayBuffer());
      } else {
        return;
      }
      let frames;
      try {
        frames = parser.push(data);
      } catch (e) {
        fail(new AsrError('E_PROTOCOL', `协议解析失败: ${e.message}`));
        return;
      }
      for (const f of frames) handleFrame(f);
    });
    ws2.addEventListener('error', (ev) => {
      const msg = ev && ev.message ? String(ev.message) : '';
      if (!started && !finishedUpstream) {
        fail(new AsrError('E_CONNECT', `连接中断: ${msg}`, { retryable: true }));
      } else {
        // 音频中途断流：不可续传，如实报错
        fail(new AsrError('E_STREAM_BROKEN', `识别流中断${msg ? ': ' + msg : ''}`, { retryable: false }));
      }
    });
    ws2.addEventListener('close', (ev) => {
      if (!settled) {
        // 未完成即关闭
        if (finishedUpstream) {
          // 已发完音频等待结果被关闭
          fail(new AsrError('E_CLOSED_EARLY', `等待最终结果时连接被关闭(code=${ev?.code ?? '?'})`));
        } else {
          fail(new AsrError('E_CLOSED_EARLY', `识别会话被服务端关闭(code=${ev?.code ?? '?'})`));
        }
      }
    });
  }

  async function run() {
    // 建连（带重试）
    let ws2 = null;
    let lastErr = null;
    const attempts = Math.max(1, retries + 1);
    for (let i = 0; i < attempts; i++) {
      try {
        connectAttempts = i + 1;
        ws2 = await connectOnce();
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (cancelled) throw new AsrError('E_CANCELLED', '已取消');
        if (i < attempts - 1) {
          const backoff = 300 * (i + 1);
          logger.warn(`[asr] 建连失败(${e.code})，${backoff}ms 后重试 ${i + 2}/${attempts}`);
          await new Promise((r) => setTimeout(r, backoff));
        }
      }
    }
    if (lastErr) throw lastErr;

    attachSession(ws2);
    sendStart();
    started = true;
    bumpIdle();
  }

  function sendAudio(pcmBuffer) {
    if (!ws || !started || settled || finishedUpstream) return false;
    if (!pcmBuffer || !pcmBuffer.length) return true;
    const gz = gzipSync(pcmBuffer);
    // 音频帧无序号（见 volcano-protocol.js encodeAudioFrame 实测说明）
    ws.send(encodeAudioFrame(gz, false));
    bumpIdle();
    return true;
  }

  function stop() {
    if (!ws || !started || settled || finishedUpstream) return promise;
    finishedUpstream = true;
    // 官方时序：最后一包音频 flags=LAST_NO_SEQ（无序号），payload 为空、不压缩
    try {
      ws.send(encodeAudioFrame(Buffer.alloc(0), true));
    } catch (e) {
      fail(new AsrError('E_SEND_LAST', `发送结束帧失败: ${e.message}`));
      return promise;
    }
    bumpIdle();
    clearTimeout(endTimer);
    endTimer = setTimeout(() => {
      fail(new AsrError('E_END_TIMEOUT', `结束音频后 ${endTimeoutMs}ms 内未收到最终结果`, { retryable: true }));
    }, endTimeoutMs);
    return promise;
  }

  function cancel() {
    cancelled = true;
    settle('reject', new AsrError('E_CANCELLED', '已取消'));
  }

  const api = {
    promise,
    onPartial(fn) {
      callbacks.onPartial = fn;
      return api;
    },
    sendAudio,
    stop,
    cancel,
    get started() {
      return started;
    },
  };

  run().catch((e) => fail(e instanceof AsrError ? e : new AsrError('E_INTERNAL', String(e && e.message || e))));
  return api;
}

function defaultWebSocketFactory(url, opts) {
  // Node >= 22 全局 WebSocket (undici) 支持非标准 headers 选项
  return new WebSocket(url, opts);
}

function rejected(err) {
  return {
    promise: Promise.reject(err),
    onPartial() {
      return this;
    },
    sendAudio() {
      return false;
    },
    stop() {
      return Promise.reject(err);
    },
    cancel() {},
    started: false,
  };
}

module.exports = {
  createAsrSession,
  AsrError,
  DEFAULT_ENDPOINT,
  RESOURCE_ID_20_DURATION,
  RESOURCE_ID_20_CONCURRENT,
  RESOURCE_ID_10_DURATION,
  RESOURCE_ID_10_CONCURRENT,
  resourceIdFor,
};
