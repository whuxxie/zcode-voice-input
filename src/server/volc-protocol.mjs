/**
 * 火山引擎豆包流式语音识别（SAUC）WebSocket 二进制协议编解码。
 * 规约来源: docs.volcengine.com 《大模型流式语音识别 WebSocket API》
 *
 * 二进制帧布局: 4 字节头 + 载荷
 *   byte0: [protocol_version(4b) | header_size(4b)]  → 0x11 (v1, 头占 4 字节)
 *   byte1: [message_type(4b) | flags(4b)]
 *     message_type: 0b0001 full client request / 0b0010 audio-only request
 *                   0b1001 full server response / 0b1111 error response
 *     flags: 0b0000 无序号 / 0b0010 最后一包(无序号) / 0b0011 最后一包(负序号, 服务端)
 *   byte2: [serialization(4b) | compression(4b)]
 *     serialization: 0b0000 raw / 0b0001 JSON
 *     compression:   0b0000 none / 0b0001 gzip
 *   byte3: 保留 0x00
 *   之后:
 *     full request : [4B payload_size][gzip(json)]
 *     audio request: [4B payload_size][gzip(pcm bytes)]（仅 compression=gzip 时压缩）
 *     server resp  : [4B sequence(有 flags=0b01/0b11 时)][4B payload_size][gzip(json)]
 *     error resp   : [4B error_code][4B payload_size][gzip(json)]
 */
import { gzipSync, gunzipSync } from "node:zlib";

export const PROTOCOL_VERSION = 0b0001;
export const HEADER_SIZE_BYTES = 4;

export const MESSAGE_TYPE = {
  FULL_CLIENT_REQUEST: 0b0001,
  AUDIO_ONLY_REQUEST: 0b0010,
  FULL_SERVER_RESPONSE: 0b1001,
  ERROR_RESPONSE: 0b1111,
};

export const MESSAGE_TYPE_FLAGS = {
  NO_SEQUENCE: 0b0000,
  POSITIVE_SEQUENCE: 0b0001,
  LAST_NO_SEQUENCE: 0b0010,
  LAST_NEGATIVE_SEQUENCE: 0b0011,
};

export const SERIALIZATION = { RAW: 0b0000, JSON: 0b0001 };
export const COMPRESSION = { NONE: 0b0000, GZIP: 0b0001 };

const GZIP_MAGIC = 0x1f8b;

/**
 * 编码一个完整客户端请求帧（JSON + gzip）。
 * @param {object} payload
 * @returns {Buffer}
 */
export function encodeFullClientRequest(payload) {
  return encodeFullRequestFrame(JSON.stringify(payload), MESSAGE_TYPE.FULL_CLIENT_REQUEST, MESSAGE_TYPE_FLAGS.NO_SEQUENCE, SERIALIZATION.JSON, COMPRESSION.GZIP);
}

/**
 * 编码音频帧。最后一包用 flags=LAST_NO_SEQUENCE（官方《全双工》文档：负包不带序号）。
 * @param {Buffer|Uint8Array} audioBytes 原始 PCM
 * @param {boolean} isLast
 */
export function encodeAudioRequest(audioBytes, isLast = false) {
  return encodeFullRequestFrame(audioBytes, MESSAGE_TYPE.AUDIO_ONLY_REQUEST, isLast ? MESSAGE_TYPE_FLAGS.LAST_NO_SEQUENCE : MESSAGE_TYPE_FLAGS.NO_SEQUENCE, SERIALIZATION.RAW, COMPRESSION.GZIP);
}

function encodeFullRequestFrame(body, messageType, flags, serialization, compression) {
  const raw = Buffer.isBuffer(body) ? body : Buffer.from(body, "utf8");
  const compressed = compression === COMPRESSION.GZIP ? zlibGzip(raw) : raw;
  const header = Buffer.alloc(4);
  header[0] = (PROTOCOL_VERSION << 4) | (HEADER_SIZE_BYTES / 4);
  header[1] = (messageType << 4) | flags;
  header[2] = (serialization << 4) | compression;
  header[3] = 0x00;
  const size = Buffer.alloc(4);
  size.writeUInt32BE(compressed.length, 0);
  return Buffer.concat([header, size, compressed]);
}

function zlibGzip(buf) {
  return gzipSync(buf);
}

/**
 * 解析服务端响应帧（可能一次 TCP 分片包含多帧，这里解析单帧并返回消费长度）。
 * @param {Buffer} buf 缓冲区（至少 4 字节）
 * @returns {{consumed: number, frame: {
 *   messageType: number, flags: number, serialization: number, compression: number,
 *   sequence?: number, errorCode?: number,
 *   payload?: Buffer, json?: object, error?: object, isLastPacket: boolean
 * }} | null} 数据不足时返回 null
 */
export function tryParseServerFrame(buf) {
  if (!buf || buf.length < 4) return null;
  const protocolVersion = buf[0] >> 4;
  const headerSize = (buf[0] & 0x0f) * 4;
  if (protocolVersion !== PROTOCOL_VERSION) {
    throw new Error(`unsupported protocol version ${protocolVersion}`);
  }
  if (buf.length < headerSize) return null;
  const messageType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const serialization = buf[2] >> 4;
  const compression = buf[2] & 0x0f;

  let offset = headerSize;
  const frame = {
    messageType, flags, serialization, compression,
    isLastPacket: flags === MESSAGE_TYPE_FLAGS.LAST_NO_SEQUENCE || flags === MESSAGE_TYPE_FLAGS.LAST_NEGATIVE_SEQUENCE,
  };

  if (messageType === MESSAGE_TYPE.FULL_SERVER_RESPONSE) {
    if (flags === MESSAGE_TYPE_FLAGS.POSITIVE_SEQUENCE || flags === MESSAGE_TYPE_FLAGS.LAST_NEGATIVE_SEQUENCE) {
      if (buf.length < offset + 4) return null;
      frame.sequence = buf.readInt32BE(offset);
      offset += 4;
    }
  } else if (messageType === MESSAGE_TYPE.ERROR_RESPONSE) {
    if (buf.length < offset + 4) return null;
    frame.errorCode = buf.readUInt32BE(offset);
    offset += 4;
  } else {
    throw new Error(`unexpected server message type 0x${messageType.toString(16)}`);
  }

  if (buf.length < offset + 4) return null;
  const payloadSize = buf.readUInt32BE(offset);
  offset += 4;
  if (buf.length < offset + payloadSize) return null;
  const raw = buf.subarray(offset, offset + payloadSize);
  const payload = compression === COMPRESSION.GZIP ? gunzipIfGzip(raw) : Buffer.from(raw);
  frame.payload = payload;
  if (serialization === SERIALIZATION.JSON && payload) {
    frame.json = JSON.parse(payload.toString("utf8"));
  }
  frame.consumed = offset + payloadSize;
  return { consumed: frame.consumed, frame };
}

function gunzipIfGzip(buf) {
  if (buf.length >= 2 && buf[0] === (GZIP_MAGIC >> 8) && buf[1] === (GZIP_MAGIC & 0xff)) {
    return gunzipSync(buf);
  }
  return Buffer.from(buf);
}

/**
 * 从响应 JSON 提取识别文本与分句。
 * 响应形如 { audio_info: {duration}, result: { text, utterances: [{definite, text, start_time, end_time, words}] } }
 */
export function parseAsrResult(json) {
  if (!json) return { text: "", utterances: [] };
  const result = json.result ?? {};
  const utterances = Array.isArray(result.utterances) ? result.utterances : [];
  return {
    text: typeof result.text === "string" ? result.text : "",
    utterances: utterances.map((u) => ({
      definite: Boolean(u.definite),
      text: typeof u.text === "string" ? u.text : "",
      startTime: u.start_time ?? u.startTime ?? 0,
      endTime: u.end_time ?? u.endTime ?? 0,
    })),
    durationMs: json.audio_info?.duration ?? json.audio_info?.durationMs ?? null,
  };
}
