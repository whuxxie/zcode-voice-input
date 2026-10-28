// 测试 1：ASR WebSocket 二进制协议解析（编解码往返、分块流式、错误帧）
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MESSAGE_TYPE, MSG_TYPE_FLAGS, SERIALIZATION, COMPRESSION,
  encodeFrame, encodeJsonFrame, encodeAudioFrame, createFrameParser, parseResponseFrame,
  buildStartRequestPayload, gzipSync, gunzipSync,
} from '../plugin/server/volcano-protocol.js';

test('全客户端请求帧：头字节符合官方规范', () => {
  const payload = gzipSync(Buffer.from(JSON.stringify({ a: 1 })));
  const frame = encodeFrame({
    messageType: MESSAGE_TYPE.FULL_CLIENT_REQUEST,
    flags: MSG_TYPE_FLAGS.NO_SEQ,
    serialization: SERIALIZATION.JSON,
    compression: COMPRESSION.GZIP,
    payload,
  });
  assert.equal(frame[0] >> 4, 0b0001, '协议版本=1');
  assert.equal(frame[0] & 0x0f, 0b0001, '头大小=1个4字节');
  assert.equal(frame[1] >> 4, MESSAGE_TYPE.FULL_CLIENT_REQUEST);
  assert.equal(frame[1] & 0x0f, MSG_TYPE_FLAGS.NO_SEQ);
  assert.equal(frame[2] >> 4, SERIALIZATION.JSON);
  assert.equal(frame[2] & 0x0f, COMPRESSION.GZIP);
  assert.equal(frame[3], 0x00);
  assert.equal(frame.readUInt32BE(4), payload.length);
  assert.equal(frame.length, 4 + 4 + payload.length);
});

test('音频帧：中间帧无序号 + 最后一包 LAST_NO_SEQ 不压缩', () => {
  const chunk = gzipSync(Buffer.from([1, 2, 3]));
  const f1 = encodeAudioFrame(chunk, false);
  assert.equal(f1[1] >> 4, MESSAGE_TYPE.AUDIO_ONLY_REQUEST);
  assert.equal(f1[1] & 0x0f, MSG_TYPE_FLAGS.NO_SEQ, '中间音频帧不带序号（实测带正序号会被 bigmodel 断连）');
  assert.equal(f1.readUInt32BE(4), chunk.length, '头后紧跟 payloadSize，无序号字段');
  assert.equal(f1.length, 4 + 4 + chunk.length);
  const f2 = encodeAudioFrame(Buffer.alloc(0), true);
  assert.equal(f2[1] & 0x0f, MSG_TYPE_FLAGS.LAST_NO_SEQ);
  assert.equal(f2[2] & 0x0f, COMPRESSION.NONE, '最后一包不压缩');
  assert.equal(f2.readUInt32BE(4), 0);
});

test('解析器：跨 TCP 分块的粘包/半包处理', () => {
  const parser = createFrameParser();
  const f1 = encodeAudioFrame(gzipSync(Buffer.from('hello')), false);
  const f2 = encodeJsonFrame(MESSAGE_TYPE.FULL_SERVER_RESPONSE, MSG_TYPE_FLAGS.NEG_SEQ_LAST, { result: { text: 'x' } }, -2);
  const all = Buffer.concat([f1, f2]);
  // 逐字节喂入（最恶劣分块）
  const out = [];
  for (const b of all) out.push(...parser.push(Buffer.from([b])));
  assert.equal(out.length, 2);
  assert.equal(out[0].messageType, MESSAGE_TYPE.AUDIO_ONLY_REQUEST);
  assert.equal(out[0].sequence, undefined, '音频帧无序号');
  assert.equal(out[1].sequence, -2);
  // 第二次喂入不残留
  assert.equal(parser.buffered, 0);
});

test('解析器：整包一次性喂入', () => {
  const parser = createFrameParser();
  const f = encodeJsonFrame(MESSAGE_TYPE.FULL_CLIENT_REQUEST, MSG_TYPE_FLAGS.NO_SEQ, { hello: '火山' });
  const frames = parser.push(f);
  assert.equal(frames.length, 1);
  assert.deepEqual(gunzipSync(frames[0].payload).toString('utf8'), JSON.stringify({ hello: '火山' }));
});

test('服务器响应解析：JSON 文本 + utterances', () => {
  const resp = { audio_info: { duration: 1500 }, result: { text: '你好世界', utterances: [{ text: '你好', definite: true }] } };
  const frame = encodeJsonFrame(MESSAGE_TYPE.FULL_SERVER_RESPONSE, MSG_TYPE_FLAGS.POS_SEQ, resp, 3);
  const [parsed] = createFrameParser().push(frame);
  const r = parseResponseFrame(parsed);
  assert.equal(r.json.result.text, '你好世界');
  assert.equal(r.isLast, false);
  assert.equal(r.sequence, 3);
});

test('服务器最后响应：NEG_SEQ_LAST 标记 isLast', () => {
  const frame = encodeJsonFrame(MESSAGE_TYPE.FULL_SERVER_RESPONSE, MSG_TYPE_FLAGS.NEG_SEQ_LAST, { result: { text: '完' } }, -2);
  const [parsed] = createFrameParser().push(frame);
  const r = parseResponseFrame(parsed);
  assert.equal(r.isLast, true);
});

test('错误帧解析：错误码与消息', () => {
  const errBody = Buffer.concat([
    (() => { const b = Buffer.alloc(4); b.writeInt32BE(45000081); return b; })(),
    (() => { const b = Buffer.alloc(4); const m = gzipSync(Buffer.from('wait timeout')); b.writeUInt32BE(m.length); return Buffer.concat([b, m]); })(),
  ]);
  const frame = encodeFrame({
    messageType: MESSAGE_TYPE.ERROR_RESPONSE,
    flags: MSG_TYPE_FLAGS.NEG_SEQ_LAST,
    serialization: SERIALIZATION.NONE,
    compression: COMPRESSION.GZIP,
    payload: errBody,
    sequence: -1,
  });
  const [parsed] = createFrameParser().push(frame);
  const r = parseResponseFrame(parsed);
  assert.equal(r.errorCode, 45000081);
  assert.match(r.errorMessage, /wait timeout/);
});

test('构建首个 Full Client Request：模式/热词/参数', () => {
  const p = buildStartRequestPayload({
    mode: 'sentence', hotwords: ['Spring Boot', 'MyBatis', 'Spring Boot'], enablePunc: true,
  });
  assert.equal(p.audio.format, 'pcm');
  assert.equal(p.audio.rate, 16000);
  assert.equal(p.audio.bits, 16);
  assert.equal(p.audio.channel, 1);
  assert.equal(p.request.model_name, 'bigmodel');
  assert.equal(p.request.show_utterances, true);
  assert.equal(p.request.result_type, 'full');
  const ctx = JSON.parse(p.request.corpus.context);
  assert.equal(ctx.hotwords.filter((h) => h.word === 'Spring Boot').length, 1, '热词去重');
  const p2 = buildStartRequestPayload({ mode: 'nostream' });
  assert.equal(p2.request.enable_nonstream, true);
  assert.equal(p2.request.show_utterances, false);
});

test('非法协议版本抛错并清空缓冲', () => {
  const parser = createFrameParser();
  const bad = Buffer.from([0x21, 0x10, 0x11, 0x00, 0, 0, 0, 0]);
  assert.throws(() => parser.push(bad), /协议版本/);
  assert.equal(parser.buffered, 0);
});
