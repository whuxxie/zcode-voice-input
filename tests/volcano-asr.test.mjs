// 测试 4/5：火山 ASR 客户端 — 中间/最终结果合并、网络断开、超时、重试
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createAsrSession } from '../plugin/server/volcano-asr.js';
import {
  MESSAGE_TYPE, MSG_TYPE_FLAGS, SERIALIZATION, COMPRESSION, encodeFrame,
} from '../plugin/server/volcano-protocol.js';

const require = createRequire(import.meta.url);

const CREDS = { appId: 'test-app-id', accessToken: 'test-token' };
const SILENT_LOGGER = { info() {}, warn() {}, error() {} };

/** 模拟服务器向客户端推送响应帧 */
function sendServerFrame(ws, obj, flags, seq) {
  const { encodeJsonFrame } = require('../plugin/server/volcano-protocol.js');
  ws._emit('message', { data: encodeJsonFrame(MESSAGE_TYPE.FULL_SERVER_RESPONSE, flags, obj, seq) });
}

/** 可编程假 WebSocket：模拟服务器行为序列 */
function fakeWebSocketFactory(script) {
  return (url, opts) => {
    assert.ok(opts.headers['X-Api-Resource-Id'], '必须带 X-Api-Resource-Id');
    assert.equal(opts.headers['X-Api-Sequence'], '-1');
    const listeners = {};
    const ws = {
      sent: [],
      headers: opts.headers,
      addEventListener(type, fn) {
        (listeners[type] = listeners[type] || []).push(fn);
      },
      _emit(type, ev) {
        for (const fn of listeners[type] || []) fn(ev);
      },
      send(data) {
        ws.sent.push(data);
        if (script.onSend) script.onSend(ws, data);
      },
      close() {
        ws._closed = true;
      },
      terminate() {
        ws._terminated = true;
      },
    };
    queueMicrotask(() => {
      ws._emit('open', {});
      if (script.onOpen) script.onOpen(ws);
    });
    fakeWebSocketFactory.current = ws;
    return ws;
  };
}

const encodeJsonFrame = (mt, flags, obj, seq) =>
  encodeFrame({ messageType: mt, flags, serialization: SERIALIZATION.JSON, compression: COMPRESSION.GZIP, payload: gzipSyncBuf(obj), sequence: seq });
function gzipSyncBuf(obj) {
  const { gzipSync } = require('../plugin/server/volcano-protocol.js');
  return gzipSync(Buffer.from(JSON.stringify(obj)));
}

test('缺失凭据立即拒绝且不发网络请求', async () => {
  const s = createAsrSession({ credentials: {}, logger: SILENT_LOGGER });
  await assert.rejects(s.promise, /凭据/);
});

test('中间结果与最终结果合并：partial 为全量文本，definite 分句只追加一次', async () => {
  const partials = [];
  const script = [
    { text: '你', utterances: [] },
    { text: '你好', utterances: [{ text: '你好', definite: false }] },
    { text: '你好世界', utterances: [{ text: '你好世界', definite: false }] },
  ];
  let step = 0;
  const factory = fakeWebSocketFactory({
    onSend(ws, data) {
      // 首帧是 start request；收到音频帧后逐步推送 partial
      const type = data[1] >> 4;
      if (type === MESSAGE_TYPE.AUDIO_ONLY_REQUEST && step < script.length) {
        sendServerFrame(ws, { result: script[step] }, MSG_TYPE_FLAGS.POS_SEQ, step + 1);
        step++;
      }
    },
  });
  const s = createAsrSession({
    credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory, retries: 0,
  });
  s.onPartial((p) => partials.push(p.text));
  await new Promise((r) => setTimeout(r, 10));
  s.sendAudio(Buffer.alloc(3200));
  await new Promise((r) => setTimeout(r, 10));
  s.sendAudio(Buffer.alloc(3200));
  await new Promise((r) => setTimeout(r, 10));
  s.sendAudio(Buffer.alloc(3200));
  await new Promise((r) => setTimeout(r, 10));
  const done = s.stop();
  // 服务器对最后一包回最终响应
  fakeWebSocketFactory.current._emit('message', {
    data: encodeJsonFrame(MESSAGE_TYPE.FULL_SERVER_RESPONSE, MSG_TYPE_FLAGS.NEG_SEQ_LAST, { result: { text: '你好世界' } }, -2),
  });
  const final = await done;
  assert.equal(final.text, '你好世界');
  assert.deepEqual(partials, ['你', '你好', '你好世界'], 'partial 是累计全量，不重复拼接');
});

test('definite 分句被收集且最终文本兜底正确', async () => {
  const factory = fakeWebSocketFactory({
    onSend(ws, data) {
      const type = data[1] >> 4;
      if (type === MESSAGE_TYPE.AUDIO_ONLY_REQUEST) {
        sendServerFrame(ws, {
          result: {
            text: '第一句第二句',
            utterances: [
              { text: '第一句', definite: true, start_time: 0 },
              { text: '第二句', definite: false },
            ],
          },
        }, MSG_TYPE_FLAGS.POS_SEQ, 1);
      }
    },
  });
  const s = createAsrSession({ credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory, retries: 0 });
  await new Promise((r) => setTimeout(r, 10));
  s.sendAudio(Buffer.alloc(3200));
  await new Promise((r) => setTimeout(r, 10));
  const p = s.stop();
  fakeWebSocketFactory.current._emit('message', {
    data: encodeJsonFrame(MESSAGE_TYPE.FULL_SERVER_RESPONSE, MSG_TYPE_FLAGS.NEG_SEQ_LAST, { result: {} }, -2),
  });
  const final = await p;
  assert.equal(final.text, '第一句第二句');
  assert.deepEqual(final.utterances.map((u) => u.text), ['第一句']);
});

test('重复的 definite 分句不重复收集', async () => {
  const seen = [];
  const factory = fakeWebSocketFactory({
    onSend(ws, data) {
      const type = data[1] >> 4;
      if (type === MESSAGE_TYPE.AUDIO_ONLY_REQUEST && seen.length < 3) {
        seen.push(1);
        sendServerFrame(ws, { result: { text: '重复', utterances: [{ text: '重复', definite: true, start_time: 100 }] } }, MSG_TYPE_FLAGS.POS_SEQ, seen.length);
      }
    },
  });
  const s = createAsrSession({ credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory, retries: 0 });
  await new Promise((r) => setTimeout(r, 5));
  for (let i = 0; i < 3; i++) {
    s.sendAudio(Buffer.alloc(3200));
    await new Promise((r) => setTimeout(r, 5));
  }
  const p = s.stop();
  fakeWebSocketFactory.current._emit('message', { data: encodeJsonFrame(MESSAGE_TYPE.FULL_SERVER_RESPONSE, MSG_TYPE_FLAGS.NEG_SEQ_LAST, { result: { text: '重复' } }, -2) });
  const final = await p;
  assert.equal(final.utterances.length, 1);
});

test('建连失败自动重试后成功', async () => {
  let attempts = 0;
  const factory = (url, opts) => {
    attempts++;
    const listeners = {};
    const ws = {
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      _emit(t, ev) { for (const f of listeners[t] || []) f(ev); },
      send() {}, close() {}, terminate() {},
    };
    queueMicrotask(() => {
      if (attempts === 1) ws._emit('error', { message: 'boom' });
      else ws._emit('open', {});
    });
    return ws;
  };
  const s = createAsrSession({ credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory, retries: 2 });
  s.promise.catch(() => {}); // 结束会话时的拒绝由测试消费，避免悬挂
  await new Promise((r) => setTimeout(r, 800)); // 等待退避
  assert.equal(attempts, 2);
  // 结束会话避免定时器悬挂
  s.cancel();
});

test('连接超时 -> E_CONNECT_TIMEOUT', async () => {
  const factory = () => {
    const listeners = {};
    return {
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      _emit() {}, send() {}, close() {}, terminate() {},
    };
  };
  const s = createAsrSession({
    credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory,
    connectTimeoutMs: 80, retries: 0,
  });
  await assert.rejects(s.promise, (e) => e.code === 'E_CONNECT_TIMEOUT');
});

test('音频中途断流 -> E_STREAM_BROKEN 不可自动续传', async () => {
  let wsRef;
  const factory = (url) => {
    const listeners = {};
    wsRef = {
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      _emit(t, ev) { for (const f of listeners[t] || []) f(ev); },
      send() {}, close() {}, terminate() {},
    };
    queueMicrotask(() => wsRef._emit('open', {}));
    return wsRef;
  };
  const s = createAsrSession({ credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory, retries: 0 });
  await new Promise((r) => setTimeout(r, 10));
  s.sendAudio(Buffer.alloc(3200));
  wsRef._emit('error', { message: 'reset' });
  await assert.rejects(s.promise, (e) => e.code === 'E_STREAM_BROKEN' && e.retryable === false);
});

test('服务端错误帧：55000031 标记可重试', async () => {
  let wsRef;
  const factory = () => {
    const listeners = {};
    wsRef = {
      addEventListener(t, f) { (listeners[t] = listeners[t] || []).push(f); },
      _emit(t, ev) { for (const f of listeners[t] || []) f(ev); },
      send(data) {
        const type = data[1] >> 4;
        if (type === MESSAGE_TYPE.FULL_CLIENT_REQUEST) {
          const { encodeFrame } = require('../plugin/server/volcano-protocol.js');
          const err = Buffer.alloc(4);
          err.writeInt32BE(55000031);
          const msg = Buffer.from('busy');
          const payload = Buffer.concat([err, (() => { const l = Buffer.alloc(4); l.writeUInt32BE(msg.length); return l; })(), msg]);
          queueMicrotask(() => wsRef._emit('message', {
            data: encodeFrame({ messageType: MESSAGE_TYPE.ERROR_RESPONSE, flags: MSG_TYPE_FLAGS.NO_SEQ, serialization: SERIALIZATION.NONE, compression: COMPRESSION.NONE, payload }),
          }));
        }
      },
      close() {}, terminate() {},
    };
    queueMicrotask(() => wsRef._emit('open', {}));
    return wsRef;
  };
  const s = createAsrSession({ credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory, retries: 0 });
  await assert.rejects(s.promise, (e) => e.code === 'E_ASR_55000031' && e.retryable === true);
});

test('结束音频后无响应 -> E_END_TIMEOUT', async () => {
  const factory = fakeWebSocketFactory({});
  const s = createAsrSession({
    credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory,
    retries: 0, endTimeoutMs: 80, idleTimeoutMs: 5000,
  });
  await new Promise((r) => setTimeout(r, 10));
  s.sendAudio(Buffer.alloc(3200));
  const p = s.stop();
  await assert.rejects(p, (e) => e.code === 'E_END_TIMEOUT');
});

test('空闲超时 -> E_IDLE_TIMEOUT', async () => {
  const factory = fakeWebSocketFactory({});
  const s = createAsrSession({
    credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory,
    retries: 0, idleTimeoutMs: 80,
  });
  await new Promise((r) => setTimeout(r, 10));
  s.sendAudio(Buffer.alloc(3200));
  await assert.rejects(s.promise, (e) => e.code === 'E_IDLE_TIMEOUT');
});

test('cancel 立即以 E_CANCELLED 结束', async () => {
  const factory = fakeWebSocketFactory({});
  const s = createAsrSession({ credentials: CREDS, logger: SILENT_LOGGER, webSocketFactory: factory, retries: 0 });
  await new Promise((r) => setTimeout(r, 10));
  s.cancel();
  await assert.rejects(s.promise, (e) => e.code === 'E_CANCELLED');
});
