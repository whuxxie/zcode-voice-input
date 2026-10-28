// mock-asr.js — 离线 Mock ASR 后端（与 relay.backendFactory 接口一致）
// 用途：无真实凭据时完成所有可离线完成的测试与联调。不得伪称真实 API 已联通。
// 行为：模拟分句模式（sentence）与整段模式（nostream）：
//  - 收到音频后按音量/时长切片，周期性产出 partial（全量累计文本）
//  - stop() 后产出 final
//  - 空音频 -> E_EMPTY_AUDIO；cancel() 立即中止
'use strict';

const crypto = require('node:crypto');

/** 将 PCM s16le 单声道切成 100ms 窗口并计算 RMS，返回有声音的窗口数与总时长。 */
function analyzePcm(pcm, { sampleRate = 16000 } = {}) {
  const bytesPerMs = (sampleRate * 2) / 1000;
  const window = Math.round(bytesPerMs * 100);
  let loudWindows = 0;
  let total = 0;
  for (let o = 0; o + 1 < pcm.length; o += window) {
    let sum = 0;
    const n = Math.min(window, pcm.length - o) >> 1;
    for (let i = 0; i < n; i++) {
      const s = pcm.readInt16LE(o + i * 2);
      sum += s * s;
    }
    const rms = n ? Math.sqrt(sum / n) : 0;
    if (rms > 200) loudWindows++;
    total++;
  }
  return { loudWindows, totalWindows: total, durationMs: Math.round(pcm.length / bytesPerMs) };
}

/**
 * 创建 mock backend（与真实火山会话相同的接口）。
 * options:
 *  - script: 字符串数组，模拟的分句文本（默认演示句）
 *  - latencyMs: 每个 partial 间隔（默认 80ms）
 *  - finalDelayMs: stop 后到 final 的延迟（默认 120ms）
 *  - failWith: {code, message} 强制失败（测试错误路径）
 *  - disconnectAfterMs: 模拟中途断流（E_STREAM_BROKEN）
 *  - emptyAsError: 空音频时 reject（默认 true，模拟 45000002）
 */
function createMockAsrBackend(sessionParams, events, options = {}) {
  const {
    script = Array.isArray(sessionParams?.mockScript) && sessionParams.mockScript.length
      ? sessionParams.mockScript
      : ['你好', '世界'],
    latencyMs = 80,
    finalDelayMs = 120,
    failWith = null,
    disconnectAfterMs = 0,
    emptyAsError = true,
  } = options;
  const mode = sessionParams.mode === 'nostream' ? 'nostream' : 'sentence';
  const sampleRate = sessionParams.sampleRate || 16000;

  const chunks = [];
  let cancelled = false;
  let finished = false;
  let partialTimer = null;
  let step = 0;
  const startedAt = Date.now();

  if (failWith) {
    // 延迟一拍报错，模拟建连/握手后的失败
    setTimeout(() => {
      const e = new Error(failWith.message || 'mock failure');
      e.code = failWith.code || 'E_MOCK';
      events.error(e);
    }, 30);
    return {
      sendAudio() {},
      stop: () => Promise.reject(Object.assign(new Error(failWith.message || 'mock failure'), { code: failWith.code || 'E_MOCK' })),
      cancel() {},
    };
  }

  function currentFullText() {
    return script.slice(0, Math.min(step, script.length)).join('');
  }

  function startPartialLoop() {
    partialTimer = setInterval(() => {
      if (cancelled || finished) return;
      if (disconnectAfterMs && Date.now() - startedAt >= disconnectAfterMs) {
        clearInterval(partialTimer);
        events.error(new Error('mock stream broken'));
        return;
      }
      if (step < script.length && chunks.length) {
        step++;
        const text = currentFullText();
        const definiteTexts =
          mode === 'sentence' ? script.slice(0, step).filter(() => true) : [];
        events.partial({
          text,
          definiteTexts,
        });
      }
    }, latencyMs);
  }

  return {
    sendAudio(pcm) {
      if (cancelled || finished) return;
      chunks.push(Buffer.from(pcm));
      if (chunks.length === 1) startPartialLoop();
    },
    async stop() {
      finished = true;
      if (partialTimer) clearInterval(partialTimer);
      const pcm = Buffer.concat(chunks);
      const { totalWindows, loudWindows, durationMs } = analyzePcm(pcm, { sampleRate });
      if (emptyAsError && (pcm.length === 0 || loudWindows === 0)) {
        const err = new Error('空音频或无声（mock 45000002）');
        err.code = 'E_ASR_45000002';
        throw err;
      }
      await new Promise((r) => setTimeout(r, finalDelayMs));
      if (cancelled) throw Object.assign(new Error('已取消'), { code: 'E_CANCELLED' });
      const n = Math.max(1, Math.min(script.length, Math.ceil(loudWindows / Math.max(1, totalWindows / script.length)) || 1));
      const text = script.slice(0, n).join('');
      events.final({ text, durationMs });
      return { text, durationMs, mock: true, requestId: crypto.randomUUID() };
    },
    cancel() {
      cancelled = true;
      finished = true;
      if (partialTimer) clearInterval(partialTimer);
    },
  };
}

module.exports = { createMockAsrBackend, analyzePcm };
