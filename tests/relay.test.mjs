// 测试 2/6/7/8：中继 + Mock 识别全链路（hello/ready/partial/final、取消、并发、空白音频、长短语音）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { createRelay } from '../plugin/server/relay.js';
import { createMockAsrBackend } from '../plugin/server/mock-asr.js';
import { createBackendFactory } from '../plugin/server/backend-factory.mjs';

const require = createRequire(import.meta.url);
const SILENT = { info() {}, warn() {}, error() {} };

async function makeRelay(mockOptions, { maxSessions = 1 } = {}) {
  const backendFactory = async (sessionParams, events) =>
    createMockAsrBackend(sessionParams, events, mockOptions || {});
  const relay = await createRelay({ backendFactory, logger: SILENT, maxSessions });
  return relay;
}

async function sendHello(relay, overrides = {}) {
  const ws = new WebSocket(relay.url);
  await new Promise((resolve, reject) => {
    ws.on('open', resolve);
    ws.on('error', reject);
  });
  const events = [];
  ws.on('message', (d) => events.push(JSON.parse(d.toString())));
  ws.send(JSON.stringify({ type: 'hello', token: relay.token, mode: 'sentence', sampleRate: 16000, ...overrides }));
  await waitFor(events, 'ready');
  return { ws, events };
}

async function waitFor(events, type, timeout = 3000) {
  const t0 = Date.now();
  for (;;) {
    const found = events.find((e) => e.type === type);
    if (found) return found;
    if (Date.now() - t0 > timeout) throw new Error(`等待 ${type} 超时; got ${events.map((e) => e.type).join(',')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function waitForPartialText(events, text, timeout = 5000) {
  const t0 = Date.now();
  for (;;) {
    const found = events.find((e) => e.type === 'partial' && e.text === text);
    if (found) return found;
    if (Date.now() - t0 > timeout) throw new Error(`等待 partial="${text}" 超时; got ${events.filter((e) => e.type === 'partial').map((e) => e.text).join('|')}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function pcmMs(ms, sampleRate = 16000, amplitude = 3000) {
  const n = Math.round((sampleRate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amplitude * Math.sin((i / sampleRate) * 440 * 2 * Math.PI)), i * 2);
  return b;
}

test('全链路：hello → ready → 音频 → partial → stop → final', async () => {
  const relay = await makeRelay({ script: ['你好', '世界'], latencyMs: 20, finalDelayMs: 20 });
  try {
    const { ws, events } = await sendHello(relay);
    ws.send(pcmMs(400));
    // 等待累积到完整文本的 partial（partial 为累计全量文本）
    const partial = await waitForPartialText(events, '你好世界');
    assert.equal(partial.text, '你好世界');
    ws.send(JSON.stringify({ type: 'stop' }));
    const final = await waitFor(events, 'final');
    assert.equal(final.text, '你好世界');
    assert.ok(final.durationMs >= 200);
    ws.close();
  } finally {
    relay.close();
  }
});

test('nostream 模式：停止后一次性返回整段', async () => {
  const relay = await makeRelay({ script: ['只', '要', '最后'], latencyMs: 15, finalDelayMs: 10 });
  try {
    const { ws, events } = await sendHello(relay, { mode: 'nostream' });
    ws.send(pcmMs(200));
    await new Promise((r) => setTimeout(r, 80));
    ws.send(JSON.stringify({ type: 'stop' }));
    const final = await waitFor(events, 'final');
    assert.ok(final.text.length >= 1);
    ws.close();
  } finally {
    relay.close();
  }
});

test('token 错误被拒绝且连接关闭', async () => {
  const relay = await makeRelay({});
  try {
    const ws = new WebSocket(relay.url);
    await new Promise((r) => ws.on('open', r));
    const events = [];
    let closed = false;
    ws.on('message', (d) => events.push(JSON.parse(d.toString())));
    ws.on('close', () => (closed = true));
    ws.send(JSON.stringify({ type: 'hello', token: 'wrong-token' }));
    await waitFor(events, 'error');
    assert.equal(events[0].code, 'E_AUTH');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed, true);
    ws.terminate();
  } finally {
    relay.close();
  }
});

test('音频先于 hello 被拒绝', async () => {
  const relay = await makeRelay({});
  try {
    const ws = new WebSocket(relay.url);
    await new Promise((r) => ws.on('open', r));
    const events = [];
    ws.on('message', (d) => events.push(JSON.parse(d.toString())));
    ws.send(Buffer.alloc(320));
    await waitFor(events, 'error');
    assert.equal(events[0].code, 'E_AUTH');
    ws.terminate();
  } finally {
    relay.close();
  }
});

test('取消录音：立即 cancelled，不产生 final', async () => {
  const relay = await makeRelay({ script: ['a', 'b', 'c'], latencyMs: 30, finalDelayMs: 30 });
  try {
    const { ws, events } = await sendHello(relay);
    ws.send(pcmMs(200));
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ type: 'cancel' }));
    const cancelled = await waitFor(events, 'cancelled');
    assert.equal(cancelled.type, 'cancelled');
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(events.find((e) => e.type === 'final'), undefined);
    ws.close();
  } finally {
    relay.close();
  }
});

test('重复点击（第二个连接）受 maxSessions 限制', async () => {
  const relay = await makeRelay({ script: ['x'], latencyMs: 40, finalDelayMs: 40 });
  try {
    const { ws } = await sendHello(relay);
    ws.send(pcmMs(200));
    const ws2 = new WebSocket(relay.url);
    await new Promise((r) => ws2.on('open', r));
    const events2 = [];
    let closed2 = false;
    ws2.on('message', (d) => events2.push(JSON.parse(d.toString())));
    ws2.on('close', () => (closed2 = true));
    ws2.send(JSON.stringify({ type: 'hello', token: relay.token }));
    await waitFor(events2, 'error');
    assert.equal(events2[0].code, 'E_BUSY');
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(closed2, true);
    ws.terminate();
    ws2.terminate();
  } finally {
    relay.close();
  }
});

test('空白音频：stop 返回空音频错误（模拟 45000002）', async () => {
  const relay = await makeRelay({ script: ['x'], latencyMs: 10, finalDelayMs: 10 });
  try {
    const { ws, events } = await sendHello(relay);
    ws.send(Buffer.alloc(3200 * 2)); // 静音
    await new Promise((r) => setTimeout(r, 30));
    ws.send(JSON.stringify({ type: 'stop' }));
    const err = await waitFor(events, 'error');
    assert.equal(err.code, 'E_ASR_45000002');
    assert.match(err.message, /空音频|无声/);
    ws.close();
  } finally {
    relay.close();
  }
});

test('完全不发音频直接 stop：报错', async () => {
  const relay = await makeRelay({});
  try {
    const { ws, events } = await sendHello(relay);
    ws.send(JSON.stringify({ type: 'stop' }));
    const err = await waitFor(events, 'error');
    assert.equal(err.code, 'E_ASR_45000002');
    ws.close();
  } finally {
    relay.close();
  }
});

test('短语音：一句 300ms', async () => {
  const relay = await makeRelay({ script: ['短句'], latencyMs: 10, finalDelayMs: 10 });
  try {
    const { ws, events } = await sendHello(relay);
    ws.send(pcmMs(300));
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ type: 'stop' }));
    const final = await waitFor(events, 'final');
    assert.equal(final.text, '短句');
    ws.close();
  } finally {
    relay.close();
  }
});

test('长语音：50 分句 10 秒音频分片传输', async () => {
  const script = Array.from({ length: 50 }, (_, i) => `第${i + 1}句`);
  const relay = await makeRelay({ script, latencyMs: 5, finalDelayMs: 20 });
  try {
    const { ws, events } = await sendHello(relay);
    for (let i = 0; i < 100; i++) ws.send(pcmMs(100, 16000, 4000));
    await new Promise((r) => setTimeout(r, 400));
    ws.send(JSON.stringify({ type: 'stop' }));
    const final = await waitFor(events, 'final', 5000);
    assert.equal(final.text.length, script.join('').length, '最终文本覆盖全部分句');
    const partials = events.filter((e) => e.type === 'partial');
    assert.ok(partials.length >= 10, `有渐进 partial（实际 ${partials.length}）`);
    ws.close();
  } finally {
    relay.close();
  }
});

test('后处理设置透传：final 文本经过 applyPost（真实后端工厂路径）', async () => {
  const backendFactory = createBackendFactory({
    logger: SILENT,
    getConfig: () => ({ useMock: true, model: '2.0', billing: 'duration', endpoint: '' }),
    getCredentials: () => ({ hasAny: false, hasNew: false, hasLegacy: false }),
  });
  const relay = await createRelay({ backendFactory, logger: SILENT });
  try {
    const { ws, events } = await sendHello(relay, {
      settings: { applyCaseFix: true, includeBuiltinTerms: false },
      dictionary: [{ word: 'Spring Boot', match: ['springboot'] }],
      mockScript: ['springboot项目'],
    });
    ws.send(pcmMs(300));
    await new Promise((r) => setTimeout(r, 60));
    ws.send(JSON.stringify({ type: 'stop' }));
    const final = await waitFor(events, 'final');
    assert.equal(final.text, 'Spring Boot项目', '整词规范写法生效');
    assert.equal(final.mock, true, '标记为 mock 结果');
    ws.close();
  } finally {
    relay.close();
  }
});

test('强制失败后端：错误透传到面板', async () => {
  const backendFactory = async (_p, events) =>
    createMockAsrBackend(_p, events, { failWith: { code: 'E_ASR_55000031', message: '服务繁忙' } });
  const relay = await createRelay({ backendFactory, logger: SILENT });
  try {
    const { ws, events } = await sendHello(relay);
    const err = await waitFor(events, 'error');
    assert.equal(err.code, 'E_ASR_55000031');
    ws.close();
  } finally {
    relay.close();
  }
});

test('中途断流模拟：disconnectAfterMs 后报错', async () => {
  const relay = await makeRelay({ script: ['a', 'b'], latencyMs: 20, disconnectAfterMs: 60 });
  try {
    const { ws, events } = await sendHello(relay);
    ws.send(pcmMs(200));
    const err = await waitFor(events, 'error', 3000);
    assert.match(err.message, /断|broken/i);
    ws.close();
  } finally {
    relay.close();
  }
});

test('回环校验：非 ws 升级请求被拒绝', async () => {
  const relay = await makeRelay({});
  try {
    const res = await fetch(`http://127.0.0.1:${relay.port}/probe`).catch((e) => e);
    if (!(res instanceof Error)) {
      assert.equal(res.status, 426);
    }
  } finally {
    relay.close();
  }
});
