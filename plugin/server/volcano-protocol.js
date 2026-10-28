// volcano-protocol.js — 火山引擎大模型流式语音识别 WebSocket 二进制协议编解码
// 协议依据官方文档:
//   https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1
// 帧结构: 4字节头 [+ 4字节序号(仅当flags带序号)] [+ 4字节负载大小] [负载]
//   byte0: 4bit协议版本(0b0001) << 4 | 4bit头大小(单位:4字节, 0b0001)
//   byte1: 4bit消息类型 << 4 | 4bit消息类型专用flags
//   byte2: 4bit序列化方法 << 4 | 4bit压缩方法
//   byte3: 保留 0x00
'use strict';

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE_WORDS = 0b0001; // 1 * 4 bytes
const HEADER_BYTES = 4;

const MESSAGE_TYPE = {
  FULL_CLIENT_REQUEST: 0b0001,
  AUDIO_ONLY_REQUEST: 0b0010,
  FULL_SERVER_RESPONSE: 0b1001,
  ERROR_RESPONSE: 0b1111,
};

const MSG_TYPE_FLAGS = {
  NO_SEQ: 0b0000, // 无序号
  POS_SEQ: 0b0001, // 带4字节正序号
  LAST_NO_SEQ: 0b0010, // 最后一包（无序号）— 最后一包音频
  NEG_SEQ_LAST: 0b0011, // 带负序号且为最后一包（服务器最后响应/错误）
};

const SERIALIZATION = { NONE: 0b0000, JSON: 0b0001 };
const COMPRESSION = { NONE: 0b0000, GZIP: 0b0001 };

// 官方错误码（摘录）
const ERROR_CODES = {
  20000000: '成功',
  45000001: '请求参数非法',
  45000002: '空音频',
  45000003: '数据包非法',
  45000081: '等待超时',
  45000151: '音频格式非法',
  50000003: '任务不存在',
  55000031: '服务繁忙',
  55000032: '服务内部错误',
};

function protocolVersionOf(headerByte0) {
  return headerByte0 >> 4;
}
function headerSizeBytesOf(headerByte0) {
  return (headerByte0 & 0x0f) * 4;
}

/** 编码整帧（不带序号）。payload 需已压缩（如 gzip），serialization/compression 按实际填写。 */
function encodeFrame({ messageType, flags, serialization, compression, payload, sequence }) {
  if (!Number.isInteger(messageType)) throw new TypeError('messageType required');
  const useSeq = flags === MSG_TYPE_FLAGS.POS_SEQ || flags === MSG_TYPE_FLAGS.NEG_SEQ_LAST;
  if (useSeq && !Number.isInteger(sequence)) throw new TypeError('sequence required for seq flags');
  const size = HEADER_BYTES + (useSeq ? 4 : 0) + 4 + (payload ? payload.length : 0);
  const buf = Buffer.allocUnsafe(size);
  let o = 0;
  buf[o++] = (PROTOCOL_VERSION << 4) | HEADER_SIZE_WORDS;
  buf[o++] = (messageType << 4) | (flags & 0x0f);
  buf[o++] = ((serialization & 0x0f) << 4) | (compression & 0x0f);
  buf[o++] = 0x00;
  if (useSeq) {
    buf.writeInt32BE(sequence | 0, o);
    o += 4;
  }
  buf.writeInt32BE(payload ? payload.length : 0, o);
  o += 4;
  if (payload && payload.length) {
    payload.copy(buf, o);
  }
  return buf;
}

/** 编码 JSON 负载（gzip 压缩）并封帧。 */
function encodeJsonFrame(messageType, flags, obj, sequence) {
  const raw = Buffer.from(JSON.stringify(obj), 'utf8');
  const payload = gzipSync(raw);
  return encodeFrame({
    messageType,
    flags,
    serialization: SERIALIZATION.JSON,
    compression: COMPRESSION.GZIP,
    payload,
    sequence,
  });
}

/**
 * 编码音频帧。payload 为已压缩音频分片。
 * 实测（2026-10-28，v3/sauc/bigmodel + X-Api-Sequence: -1 会话）：
 *   - 中间音频帧必须 flags=NO_SEQ 且不带序号字段，带正序号（POS_SEQ）会被服务端直接断连(1006)；
 *   - 最后一包 flags=LAST_NO_SEQ、空负载、不压缩，服务端回 isLast 响应后正常关闭(1000)。
 */
function encodeAudioFrame(gzipPayload, last) {
  return encodeFrame({
    messageType: MESSAGE_TYPE.AUDIO_ONLY_REQUEST,
    flags: last ? MSG_TYPE_FLAGS.LAST_NO_SEQ : MSG_TYPE_FLAGS.NO_SEQ,
    serialization: SERIALIZATION.NONE,
    compression: last ? COMPRESSION.NONE : COMPRESSION.GZIP,
    payload: last ? undefined : gzipPayload,
  });
}

/**
 * 流式解析器：喂入任意分块的 WebSocket 二进制数据，产出完整帧。
 * 返回 {push(chunk) -> Frame[], reset()}
 * Frame = {messageType, flags, sequence?, payload: Buffer, errorCode?}
 */
function createFrameParser() {
  let buf = Buffer.alloc(0);
  function tryReadFrame() {
    if (buf.length < HEADER_BYTES) return null;
    const version = buf[0] >> 4;
    const headerSize = (buf[0] & 0x0f) * 4;
    if (version !== PROTOCOL_VERSION) {
      const err = new Error(`不支持的协议版本: ${version}`);
      err.code = 'E_PROTOCOL_VERSION';
      throw err;
    }
    if (buf.length < headerSize) return null;
    const messageType = buf[1] >> 4;
    const flags = buf[1] & 0x0f;
    const serialization = buf[2] >> 4;
    const compression = buf[2] & 0x0f;
    let o = headerSize;
    const hasSeq = flags === MSG_TYPE_FLAGS.POS_SEQ || flags === MSG_TYPE_FLAGS.NEG_SEQ_LAST;
    let sequence;
    if (hasSeq) {
      if (buf.length < o + 4) return null;
      sequence = buf.readInt32BE(o);
      o += 4;
    }
    if (buf.length < o + 4) return null;
    const payloadSize = buf.readUInt32BE(o);
    o += 4;
    if (buf.length < o + payloadSize) return null;
    const payload = buf.slice(o, o + payloadSize);
    buf = buf.slice(o + payloadSize);
    return { messageType, flags, serialization, compression, sequence, payload };
  }
  return {
    push(chunk) {
      if (!chunk || !chunk.length) return [];
      buf = buf.length ? Buffer.concat([buf, chunk]) : Buffer.from(chunk);
      const frames = [];
      for (;;) {
        let f;
        try {
          f = tryReadFrame();
        } catch (e) {
          buf = Buffer.alloc(0);
          throw e;
        }
        if (!f) break;
        frames.push(f);
      }
      return frames;
    },
    reset() {
      buf = Buffer.alloc(0);
    },
    get buffered() {
      return buf.length;
    },
  };
}

/** 解析服务器响应帧 -> {json?, errorCode?, errorMessage?, isLast, sequence} */
function parseResponseFrame(frame) {
  const { messageType, flags, sequence, payload } = frame;
  const isLast = flags === MSG_TYPE_FLAGS.NEG_SEQ_LAST || flags === MSG_TYPE_FLAGS.LAST_NO_SEQ;
  let out = { messageType, flags, sequence, isLast, rawPayload: payload };
  if (messageType === MESSAGE_TYPE.ERROR_RESPONSE) {
    // 错误负载: 4字节错误码 + 4字节大小 + 错误消息
    let errorCode = 0;
    let message = '';
    if (payload.length >= 4) {
      errorCode = payload.readInt32BE(0);
      let o = 4;
      if (payload.length >= o + 4) {
        const size = payload.readUInt32BE(o);
        o += 4;
        const body = payload.slice(o, o + size);
        message = inflateMaybe(body, frame.compression).toString('utf8');
      } else if (payload.length > o) {
        message = inflateMaybe(payload.slice(o), frame.compression).toString('utf8');
      }
    }
    out.errorCode = errorCode;
    out.errorMessage = message || (ERROR_CODES[errorCode] ?? `未知错误 ${errorCode}`);
  } else if (messageType === MESSAGE_TYPE.FULL_SERVER_RESPONSE) {
    const body = inflateMaybe(payload, frame.compression);
    if (frame.serialization === SERIALIZATION.JSON && body.length) {
      out.json = JSON.parse(body.toString('utf8'));
    } else {
      out.json = {};
    }
  }
  return out;
}

function inflateMaybe(body, compression) {
  if (!body || !body.length) return Buffer.alloc(0);
  if (compression === COMPRESSION.GZIP) return gunzipSync(body);
  return body;
}

// node:zlib 延迟绑定，便于测试桩替换
let _zlib = null;
function zlib() {
  if (!_zlib) _zlib = require('node:zlib');
  return _zlib;
}
function gzipSync(data) {
  return zlib().gzipSync(data);
}
function gunzipSync(data) {
  return zlib().gunzipSync(data);
}

/** 构造握手后的首个 Full Client Request（含用户/音频/请求配置与热词）。 */
function buildStartRequestPayload(options) {
  const {
    uid = 'zcode-voice-input',
    sampleRate = 16000,
    mode = 'sentence', // sentence=双向流式(实时分句) | nostream=流式输入整段返回
    enablePunc = true,
    enableItn = true,
    enableDdc = false,
    hotwords = [], // [{word}] 或字符串数组
    boostingTableId,
    correctTableId,
  } = options;
  const req = {
    model_name: 'bigmodel',
    enable_punc: !!enablePunc,
    enable_itn: !!enableItn,
    enable_ddc: !!enableDdc,
    show_utterances: mode === 'sentence',
    result_type: 'full',
  };
  if (mode === 'nostream') req.enable_nonstream = true;
  const corpus = {};
  if (boostingTableId) corpus.boosting_table_id = String(boostingTableId);
  if (correctTableId) corpus.correct_table_id = String(correctTableId);
  if (Array.isArray(hotwords) && hotwords.length) {
    const seen = new Set();
    const list = hotwords
      .map((w) => (typeof w === 'string' ? { word: w } : w))
      .filter((w) => {
        if (!w || typeof w.word !== 'string' || !w.word.length) return false;
        const k = w.word.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      });
    if (list.length) corpus.context = JSON.stringify({ hotwords: list.slice(0, 100) });
  }
  if (Object.keys(corpus).length) req.corpus = corpus;
  return {
    user: {
      uid,
      platform: `ZCode-Desktop ${process.platform}`,
      sdk_version: 'zcode-voice-input',
    },
    audio: {
      format: 'pcm',
      codec: 'raw',
      rate: sampleRate,
      bits: 16,
      channel: 1,
    },
    request: req,
  };
}

module.exports = {
  PROTOCOL_VERSION,
  HEADER_BYTES,
  MESSAGE_TYPE,
  MSG_TYPE_FLAGS,
  SERIALIZATION,
  COMPRESSION,
  ERROR_CODES,
  encodeFrame,
  encodeJsonFrame,
  encodeAudioFrame,
  createFrameParser,
  parseResponseFrame,
  buildStartRequestPayload,
  gzipSync,
  gunzipSync,
};
