// panel.js — ZCode Voice Input 面板逻辑（在 zcode-sandbox 沙箱内运行，无任何密钥）
// 流程：connect 宿主 → 取中继信息 → 用户点击开始 → 麦克风(16k PCM) → ws://127.0.0.1 中继 → 实时预览/最终结果
'use strict';

const $ = (id) => document.getElementById(id);
const els = {
  statusDot: $('status-dot'),
  statusText: $('status-text'),
  timer: $('timer'),
  preview: $('preview'),
  resultWrap: $('result-wrap'),
  result: $('result'),
  previewWrap: $('preview-wrap'),
  insertHint: $('insert-hint'),
  startBtn: $('btn-start'),
  stopBtn: $('btn-stop'),
  cancelBtn: $('btn-cancel'),
  copyBtn: $('btn-copy'),
  insertBtn: $('btn-insert'),
  sendBtn: $('btn-send'),
  retryBtn: $('btn-retry'),
  clearBtn: $('btn-clear'),
  error: $('error'),
  errorText: $('error-text'),
  errorClose: $('error-close'),
  mode: $('mode'),
  device: $('device'),
  deviceRow: $('device-row'),
  backend: $('backend'),
  mockHint: $('mock-hint'),
  settings: $('settings'),
  settingsBtn: $('btn-settings'),
  optAddPunct: $('opt-add-punct'),
  optCleanRepeat: $('opt-clean-repeat'),
  optCaseFix: $('opt-case-fix'),
  optBuiltin: $('opt-builtin'),
  settingsStatus: $('settings-status'),
};

const STATE = SM.STATES;
let state = STATE.IDLE;
let app = null;
let relayInfo = null;
let ws = null;
let mediaStream = null;
let audioContext = null;
let workletNode = null;
let sourceNode = null;
let recording = { startedAt: 0, timerId: null, bytes: 0 };
let settings = { addPunctuation: false, cleanRepeat: false, applyCaseFix: false, includeBuiltinTerms: true };
let currentFinalText = '';

function setState(next, text) {
  state = next;
  const map = {
    idle: ['', '就绪'],
    starting: ['warn', '正在启动…'],
    recording: ['rec', '录音中'],
    processing: ['warn', '识别中…'],
    done: ['ok', '完成'],
    error: ['err', '出错'],
  };
  const [cls, label] = map[next] || ['', next];
  els.statusDot.className = 'dot ' + cls;
  els.statusText.textContent = text || label;
  els.startBtn.disabled = !(next === STATE.IDLE || next === STATE.DONE || next === STATE.ERROR);
  els.stopBtn.disabled = next !== STATE.RECORDING;
  els.cancelBtn.disabled = !(next === STATE.RECORDING || next === STATE.PROCESSING || next === STATE.STARTING);
  const hasResult = next === STATE.DONE && currentFinalText.length > 0;
  els.copyBtn.disabled = !hasResult;
  els.insertBtn.disabled = !hasResult;
  els.retryBtn.disabled = !hasResult;
  els.clearBtn.disabled = next === STATE.RECORDING;
  els.resultWrap.classList.toggle('hidden', !hasResult && next !== STATE.PROCESSING);
  els.previewWrap.classList.toggle('hidden', next !== STATE.RECORDING);
}

function showError(code, message, retryable) {
  els.error.classList.remove('hidden');
  els.errorText.textContent = `[${code}] ${message}` + (retryable ? '（可重试）' : '');
  setState(STATE.ERROR, '出错');
}
function hideError() {
  els.error.classList.add('hidden');
}

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- MCP Apps 连接 ----------
async function initApp() {
  // SDK 已由构建脚本直接内联为前置 module script，并挂到 window.__EXT_APPS__（宿主 CSP 不放行 data: 动态导入）
  const sdk = window.__EXT_APPS__;
  if (!sdk || !sdk.App) {
    const bootErr = window.__BOOT_ERROR__ ? '；前置SDK错误: ' + window.__BOOT_ERROR__ : '';
    throw new Error('内置 MCP Apps SDK 缺失或未执行（构建产物损坏/被沙箱拦截）' + bootErr);
  }
  app = new sdk.App({ name: 'zcode-voice-input-panel', version: '0.1.4' }, {});
  await app.connect();
  let hostCaps = null;
  try {
    hostCaps = app.getHostCapabilities?.() || null;
  } catch {}
  const canMessage = !!hostCaps?.message;
  els.sendBtn.classList.toggle('hidden', !canMessage);
  return canMessage;
}

async function loadRelayInfo() {
  const res = await app.callServerTool({ name: 'voice_relay_info', arguments: {} });
  const sc = res.structuredContent || {};
  if (!sc.url || !sc.token) throw new Error('中继信息不完整');
  relayInfo = sc;
  return sc;
}

async function loadStatusAndSettings() {
  try {
    const res = await app.callServerTool({ name: 'voice_status', arguments: {} });
    const st = res.structuredContent || {};
    const isMock = st.backendMode === 'mock';
    els.backend.textContent = isMock
      ? 'Mock 演示模式（未配置凭据）'
      : `真实模式 ${st.model} · ${st.resourceId}`;
    els.backend.classList.toggle('mock', isMock);
    els.mockHint.classList.toggle('hidden', !isMock);
  } catch {}
  try {
    const r2 = await app.callServerTool({ name: 'voice_get_settings', arguments: {} });
    settings = { ...settings, ...(r2.structuredContent || {}) };
    els.optAddPunct.checked = settings.addPunctuation === true;
    els.optCleanRepeat.checked = settings.cleanRepeat === true;
    els.optCaseFix.checked = settings.applyCaseFix === true;
    els.optBuiltin.checked = settings.includeBuiltinTerms !== false;
  } catch {}
}

// ---------- 麦克风与音频管线 ----------
const WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  constructor() { super(); this._buf = new Int16Array(2048); this._len = 0; }
  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      this._buf[this._len++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      if (this._len === this._buf.length) {
        this.port.postMessage(this._buf.slice(0, this._len));
        this._len = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

async function startAudioPipeline(deviceId) {
  const constraints = {
    audio: {
      channelCount: 1,
      echoCancellation: false,
      noiseSuppression: true,
      autoGainControl: true,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    },
  };
  mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
  audioContext = new AudioContext({ sampleRate: 16000 });
  if (audioContext.state === 'suspended') await audioContext.resume();
  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  const blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  await audioContext.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-capture');
  workletNode.port.onmessage = (ev) => {
    sendAudioChunk(ev.data);
  };
  sourceNode.connect(workletNode);
  // 不连接 destination（避免回放）
  await fillDevices();
}

async function fillDevices() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics = devices.filter((d) => d.kind === 'audioinput');
    if (els.deviceRow.classList.contains('hidden')) els.deviceRow.classList.remove('hidden');
    const current = els.device.value;
    els.device.innerHTML = '';
    for (const d of mics) {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `麦克风 ${d.deviceId.slice(0, 8)}`;
      els.device.appendChild(opt);
    }
    if (current) els.device.value = current;
  } catch {}
}

function releaseAudio() {
  try {
    workletNode && workletNode.disconnect();
    sourceNode && sourceNode.disconnect();
    if (mediaStream) for (const t of mediaStream.getTracks()) t.stop();
    if (audioContext && audioContext.state !== 'closed') audioContext.close();
  } catch {}
  workletNode = sourceNode = mediaStream = audioContext = null;
}

function stopTimer() {
  if (recording.timerId) clearInterval(recording.timerId);
  recording.timerId = null;
}

// ---------- 中继通信 ----------
function connectRelay() {
  return new Promise((resolve, reject) => {
    ws = new WebSocket(relayInfo.url);
    ws.binaryType = 'arraybuffer';
    let opened = false;
    ws.onopen = () => {
      ws.send(JSON.stringify({
        type: 'hello',
        token: relayInfo.token,
        mode: 'sentence',
        sampleRate: 16000,
        settings: {
          enablePunc: true,
          enableItn: true,
          addPunctuation: settings.addPunctuation === true,
          cleanRepeat: settings.cleanRepeat === true,
          applyCaseFix: settings.applyCaseFix === true,
          includeBuiltinTerms: settings.includeBuiltinTerms !== false,
        },
        dictionary: [],
      }));
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
      } catch {
        return;
      }
      if (msg.type === 'ready') {
        opened = true;
        resolve();
      } else if (msg.type === 'error') {
        if (!opened) reject(new Error(msg.message || '中继错误'));
        showError(msg.code || 'E_RELAY', msg.message, msg.retryable);
      } else if (msg.type === 'partial') {
        els.preview.textContent = msg.text || '（聆听中…）';
      } else if (msg.type === 'final') {
        handleFinal(msg.text || '');
      } else if (msg.type === 'cancelled') {
        setState(STATE.IDLE, '已取消');
      }
    };
    ws.onerror = () => {
      if (!opened) reject(new Error('无法连接本地语音中继（ws://127.0.0.1）'));
      else showError('E_RELAY_BROKEN', '与本地中继的连接中断', true);
    };
    ws.onclose = (ev) => {
      if (!opened) reject(new Error(`本地中继连接被拒绝 (${ev.code})`));
    };
    setTimeout(() => {
      if (!opened) reject(new Error('连接本地中继超时'));
    }, 8000);
  });
}

function sendAudioChunk(int16Buffer) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(int16Buffer);
  recording.bytes += int16Buffer.byteLength;
}

function handleFinal(text) {
  currentFinalText = text;
  els.result.value = text;
  releaseAudio();
  closeWs();
  stopTimer();
  setState(STATE.DONE);
  if (!text) {
    showError('E_EMPTY', '没有识别到内容（可能为空音频或无声），请靠近麦克风重试。', true);
  }
}

function closeWs() {
  if (ws) {
    try {
      ws.close(1000);
    } catch {}
    ws = null;
  }
}

// ---------- 录音控制（状态机防并发） ----------
async function startRecording() {
  if (!SM.canStart(state)) return; // 状态机守卫：防止多次点击产生并发录音会话
  hideError();
  currentFinalText = '';
  els.result.value = '';
  els.preview.textContent = '（聆听中…）';
  setState(STATE.STARTING);
  try {
    if (!relayInfo) await loadRelayInfo();
    await connectRelay();
    await startAudioPipeline(els.device.value || undefined);
    recording = { startedAt: Date.now(), timerId: null, bytes: 0 };
    els.timer.textContent = '00:00';
    recording.timerId = setInterval(() => {
      els.timer.textContent = fmtDuration(Date.now() - recording.startedAt);
    }, 250);
    setState(STATE.RECORDING);
  } catch (e) {
    releaseAudio();
    closeWs();
    const msg = String(e && e.message || e);
    if (/Permission|denied|NotAllowed/i.test(msg)) {
      showError('E_MIC_DENIED', '麦克风权限被拒绝。请在浏览器权限提示中允许，或检查系统麦克风隐私设置后重试。', true);
    } else {
      showError('E_START', msg, true);
    }
  }
}

function stopRecording() {
  if (!SM.canStop(state)) return;
  setState(STATE.PROCESSING);
  if (workletNode) workletNode.port.onmessage = null;
  releaseAudio();
  stopTimer();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'stop' }));
  }
}

function cancelRecording() {
  if (!SM.canCancel(state)) return;
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'cancel' }));
  }
  releaseAudio();
  closeWs();
  stopTimer();
  currentFinalText = '';
  els.preview.textContent = '';
  setState(STATE.IDLE, '已取消');
}

// ---------- 结果动作 ----------
async function copyText() {
  const text = els.result.value;
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    flash(els.copyBtn, '已复制 ✓');
  } catch (e) {
    // 兜底：选中全部并提示手动复制
    els.result.focus();
    els.result.select();
    try {
      document.execCommand('copy');
      flash(els.copyBtn, '已复制 ✓');
    } catch {
      showError('E_CLIPBOARD', '自动复制失败：文本已全选，请按 Ctrl+C 手动复制。', false);
    }
  }
}

async function insertToInput() {
  await copyText();
  flash(els.insertBtn, '已复制，请粘贴');
  els.insertHint.classList.remove('hidden');
}

async function sendToConversation() {
  const text = els.result.value;
  if (!text || !app) return;
  try {
    // ui/message 宿主 schema 要求 content 为 MCP 内容块数组
    await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    flash(els.sendBtn, '已提交，请在确认框中检查');
  } catch (e) {
    showError('E_SEND', String(e && e.message || e), false);
  }
}

function flash(btn, label) {
  const old = btn.textContent;
  btn.textContent = label;
  btn.classList.add('flash');
  setTimeout(() => {
    btn.textContent = old;
    btn.classList.remove('flash');
  }, 1600);
}

// ---------- 设置 ----------
async function persistSettings() {
  settings = {
    ...settings,
    addPunctuation: els.optAddPunct.checked,
    cleanRepeat: els.optCleanRepeat.checked,
    applyCaseFix: els.optCaseFix.checked,
    includeBuiltinTerms: els.optBuiltin.checked,
  };
  try {
    await app.callServerTool({ name: 'voice_set_settings', arguments: settings });
    els.settingsStatus.textContent = '已保存';
  } catch (e) {
    els.settingsStatus.textContent = '保存失败: ' + (e && e.message);
  }
  setTimeout(() => (els.settingsStatus.textContent = ''), 2000);
}

// ---------- 启动 ----------
(async function boot() {
  setState(STATE.IDLE);
  els.insertHint.classList.add('hidden');
  try {
    const canMessage = await initApp();
    els.sendBtn.classList.toggle('hidden', !canMessage);
    await loadRelayInfo();
    await loadStatusAndSettings();
    els.mode.textContent = '分句模式（实时）';
    setState(STATE.IDLE);
  } catch (e) {
    showError('E_INIT', String(e && e.message || e), true);
  }

  els.startBtn.addEventListener('click', startRecording);
  els.stopBtn.addEventListener('click', stopRecording);
  els.cancelBtn.addEventListener('click', cancelRecording);
  els.copyBtn.addEventListener('click', copyText);
  els.insertBtn.addEventListener('click', insertToInput);
  els.sendBtn.addEventListener('click', sendToConversation);
  els.retryBtn.addEventListener('click', () => {
    els.insertHint.classList.add('hidden');
    setState(STATE.IDLE);
    startRecording();
  });
  els.clearBtn.addEventListener('click', () => {
    currentFinalText = '';
    els.result.value = '';
    els.preview.textContent = '';
    els.insertHint.classList.add('hidden');
    setState(STATE.IDLE);
  });
  els.errorClose.addEventListener('click', hideError);
  els.settingsBtn.addEventListener('click', () => els.settings.classList.toggle('hidden'));
  for (const el of [els.optAddPunct, els.optCleanRepeat, els.optCaseFix, els.optBuiltin]) {
    el.addEventListener('change', persistSettings);
  }
  window.addEventListener('beforeunload', () => {
    cancelRecording();
  });
})();
