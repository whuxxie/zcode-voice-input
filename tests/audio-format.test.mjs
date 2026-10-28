// 测试 3：音频采样率与数据格式（s16le PCM 分析、窗口切分、静音判定）
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzePcm } from '../plugin/server/mock-asr.js';

function sinePcm(ms, sampleRate, amplitude) {
  const n = Math.round((sampleRate * ms) / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(amplitude * Math.sin((i / sampleRate) * 440 * 2 * Math.PI)), i * 2);
  return b;
}

test('16k 16bit 单声道：时长计算', () => {
  const { durationMs } = analyzePcm(sinePcm(1000, 16000, 3000), { sampleRate: 16000 });
  assert.equal(durationMs, 1000, '1000ms 音频 → 1000ms');
});

test('多采样率窗口计数（16k/44.1k/48k 由采集端重采样为16k后到达）', () => {
  for (const sr of [16000, 44100, 48000]) {
    const { totalWindows } = analyzePcm(sinePcm(1000, sr, 3000), { sampleRate: sr });
    assert.equal(totalWindows, 10, `${sr}Hz 1s = 10 个 100ms 窗口`);
  }
});

test('静音判定：振幅低于阈值 → loudWindows=0', () => {
  const { loudWindows } = analyzePcm(sinePcm(500, 16000, 50), { sampleRate: 16000 });
  assert.equal(loudWindows, 0);
});

test('有声判定：正常振幅全部窗口有声', () => {
  const { loudWindows, totalWindows } = analyzePcm(sinePcm(500, 16000, 5000), { sampleRate: 16000 });
  assert.equal(loudWindows, totalWindows);
});

test('空 PCM 安全处理', () => {
  const r = analyzePcm(Buffer.alloc(0));
  assert.equal(r.durationMs, 0);
  assert.equal(r.totalWindows, 0);
  assert.equal(r.loudWindows, 0);
});

test('奇数字节长度不崩溃（s16le 对齐）', () => {
  const b = Buffer.alloc(3);
  b.writeInt16LE(100, 0);
  const r = analyzePcm(b);
  assert.ok(r.totalWindows >= 1);
});
