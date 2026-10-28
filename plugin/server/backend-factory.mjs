// backend-factory.mjs — ASR 后端工厂：真实火山引擎 / Mock 的统一封装
// 职责：凭据读取、热词注入、后处理应用。密钥仅在本进程内使用。
'use strict';
import { createAsrSession } from './volcano-asr.js';
import { createMockAsrBackend } from './mock-asr.js';
import { hotwordList, postProcess } from './term-processor.js';

/**
 * @param deps { logger, getConfig(): {useMock, model, billing, endpoint}, getCredentials() }
 * @returns (sessionParams, events) => backend
 */
export function createBackendFactory(deps) {
  const { logger, getConfig, getCredentials } = deps;
  return async function backendFactory(sessionParams, events) {
    const cfg = getConfig();
    const cred = getCredentials();
    const settings = sessionParams.settings || {};
    const dictionary = sessionParams.dictionary || [];
    const hotwords = hotwordList({
      dictionary: dictionary.map((d) => d.word),
      includeBuiltin: settings.includeBuiltinTerms !== false,
    });

    const applyPost = (text) =>
      postProcess(text, {
        dictionary,
        addPunctuation: settings.addPunctuation === true,
        cleanRepeat: settings.cleanRepeat === true,
        applyCaseFix: settings.applyCaseFix === true,
      });

    if (cfg.useMock) {
      logger.info?.('ASR 运行于 Mock 模式（无真实凭据或显式启用），识别文本为演示数据');
      return createMockAsrBackend(sessionParams, {
        partial: (p) => events.partial({ ...p, text: applyPost(p.text), mock: true }),
        final: (p) => events.final({ ...p, text: applyPost(p.text), mock: true }),
        error: events.error,
      });
    }

    const session = createAsrSession({
      credentials: cred.hasNew
        ? { apiKey: cred.apiKey }
        : { appId: cred.appId, accessToken: cred.accessToken },
      model: cfg.model,
      billing: cfg.billing,
      endpoint: cfg.endpoint,
      mode: sessionParams.mode,
      sampleRate: sessionParams.sampleRate,
      enablePunc: settings.enablePunc !== false,
      enableItn: settings.enableItn !== false,
      enableDdc: settings.enableDdc === true,
      hotwords,
      logger,
    });
    session.onPartial((p) => events.partial({ ...p, text: applyPost(p.text) }));
    // 会话失败/自然结束必须有人消费 promise：未处理的拒绝会让 Node 直接杀死整个插件
    // MCP 进程（面板表现为 "MCP App connection is unavailable"）。stop() 路径由中继自行
    // 上报 final/error，这里只兜底 stop 未触发时的中途失败与服务端主动收尾。
    let stopCalled = false;
    session.promise.then(
      (r) => {
        if (!stopCalled) events.final({ text: applyPost(r.text), durationMs: r.durationMs });
      },
      (e) => {
        if (stopCalled) return;
        if (e && e.code === 'E_CANCELLED') return; // 取消由中继回 cancelled
        events.error({ code: (e && e.code) || 'E_ASR', message: e && e.message, retryable: !!(e && e.retryable) });
      }
    );
    const origStop = session.stop.bind(session);
    session.stop = async () => {
      stopCalled = true;
      const r = await origStop();
      return { ...r, text: applyPost(r.text) };
    };
    return {
      sendAudio: (pcm) => session.sendAudio(pcm),
      stop: session.stop,
      cancel: () => session.cancel(),
    };
  };
}
