// overlay.js — ZCode 主窗口注入的迷你语音输入条（渲染进程执行，无模块系统）
// 形态：吸附在聊天输入框旁的小麦克风按钮，position:fixed 不随对话滚动。
// 交互（输入法式）：
//   - 按住 PTT 键（默认 F8）说话，松开结束并把文字插入输入框光标处
//   - 组合键（默认 Ctrl+Shift+Space）切换开始/结束；录音中 Esc 取消
//   - 鼠标：单击麦克风 = 开始，再单击 = 结束并插入
// 识别链路复用插件 MCP 服务器：ws://127.0.0.1 中继（token 鉴权）→ 火山引擎流式 ASR。
// 由 overlay/inject-main.cjs 经 webContents.executeJavaScript 注入，配置经
// window.__viInstall(cfg) / window.__viRuntime(cfg) 注入（源 ~/.zcode/zcode-voice-input/runtime.json）。
(function () {
  'use strict';
  if (window.__viRoot) return; // 幂等：热重载前 loader 会先调 __viTeardown()

  var MAX_MS = 60000; // 单次录音上限，超时自动结束
  var MIN_MS = 250; // 短于此时长视为误触，丢弃
  var SAMPLE_RATE = 16000;

  var cfg = null; // {url, token, pttKey, toggleKeys, settings, version, useMock}
  var pttCombo = null, toggleCombo = null;

  var root = null, pill = null, bubble = null;
  var st = 'idle'; // idle | connecting | recording | finishing
  var startedAt = 0;
  var beginMode = ''; // 'ptt' | 'toggle' | 'click'
  var composer = null;

  var ws = null, wsReady = false;
  var mediaStream = null, audioContext = null, sourceNode = null, workletNode = null;
  var lastPartial = '';
  var repositionTimer = 0, observer = null;

  // ---------- 按键匹配 ----------
  function parseCombo(s) {
    var parts = String(s || '').split('+').map(function (p) { return p.trim(); }).filter(Boolean);
    var mods = { ctrl: false, alt: false, shift: false, meta: false };
    var key = '';
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i], lp = p.toLowerCase();
      if (lp === 'ctrl' || lp === 'control') mods.ctrl = true;
      else if (lp === 'alt') mods.alt = true;
      else if (lp === 'shift') mods.shift = true;
      else if (lp === 'meta' || lp === 'cmd' || lp === 'win') mods.meta = true;
      else key = normKey(p);
    }
    return mods.ctrl || mods.alt || mods.shift || mods.meta || key ? { mods: mods, key: key } : null;
  }
  function normKey(p) {
    var lp = p.toLowerCase();
    if (lp === ' ' || lp === 'space' || lp === 'spacebar') return 'Space';
    if (lp === 'esc' || lp === 'escape') return 'Escape';
    return p.length === 1 ? p.toUpperCase() : p;
  }
  function eventKey(e) {
    if (e.key === ' ') return 'Space';
    return e.key && e.key.length === 1 ? e.key.toUpperCase() : e.key;
  }
  function matchCombo(e, combo) {
    if (!combo || !combo.key) return false;
    if (!!e.ctrlKey !== combo.mods.ctrl) return false;
    if (!!e.altKey !== combo.mods.alt) return false;
    if (!!e.shiftKey !== combo.mods.shift) return false;
    if (!!e.metaKey !== combo.mods.meta) return false;
    return eventKey(e) === combo.key;
  }
  function keyLabel(s) { return String(s || '').trim() || ''; }

  // ---------- UI ----------
  var CSS =
    '.vi-root{position:fixed;z-index:50;font:12px/1.4 system-ui,-apple-system,"Segoe UI",' +
    'Roboto,"Microsoft YaHei",sans-serif;user-select:none;-webkit-user-select:none}' +
    '.vi-pill{width:34px;height:34px;border-radius:50%;border:1px solid rgba(120,140,170,.45);' +
    'background:rgba(28,32,42,.92);color:#cdd6e4;display:flex;align-items:center;justify-content:center;' +
    'cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.35);transition:transform .12s,border-color .12s}' +
    '.vi-pill:hover{transform:scale(1.08);border-color:#5a9dff}' +
    '.vi-pill .vi-mic{font-size:16px;line-height:1;pointer-events:none}' +
    '.vi-pill.rec{border-color:#ff4d4f;background:rgba(80,16,18,.95);animation:vi-pulse 1.2s ease-in-out infinite}' +
    '@keyframes vi-pulse{0%,100%{box-shadow:0 0 0 0 rgba(255,77,79,.45)}50%{box-shadow:0 0 0 7px rgba(255,77,79,0)}}' +
    '.vi-pill.err{border-color:#ff7a59}' +
    '.vi-bubble{position:absolute;right:0;bottom:42px;min-width:280px;max-width:min(600px,60vw);max-height:150px;' +
    'overflow-y:auto;overscroll-behavior:contain;background:rgba(19,22,30,.97);color:#dbe4f0;border:1px solid rgba(120,140,170,.4);' +
    'border-radius:10px;padding:8px 11px;white-space:pre-wrap;overflow-wrap:anywhere;' +
    'box-shadow:0 6px 24px rgba(0,0,0,.45);display:none;scrollbar-width:thin}' +
    '.vi-bubble::-webkit-scrollbar{width:6px}' +
    '.vi-bubble::-webkit-scrollbar-thumb{background:rgba(120,140,170,.5);border-radius:3px}' +
    '.vi-bubble.show{display:block}' +
    '.vi-bubble .vi-hint{color:#8b96a8;font-size:11px;margin-top:4px}' +
    '.vi-bubble.err{color:#ff9b8a;border-color:#ff7a59}';

  function buildDom() {
    if (root) return;
    var style = document.createElement('style');
    style.id = 'vi-style';
    style.textContent = CSS;
    document.head.appendChild(style);

    root = document.createElement('div');
    root.className = 'vi-root';
    root.id = 'vi-root';
    root.style.display = 'none';

    bubble = document.createElement('div');
    bubble.className = 'vi-bubble';

    pill = document.createElement('div');
    pill.className = 'vi-pill';
    pill.title = '语音输入：单击开始/结束；按住 ' + keyLabel(cfg && cfg.pttKey) + ' 说话松开插入';
    var mic = document.createElement('span');
    mic.className = 'vi-mic';
    mic.textContent = '🎤';
    pill.appendChild(mic);

    root.appendChild(bubble);
    root.appendChild(pill);
    document.body.appendChild(root);

    pill.addEventListener('mousedown', function (e) { e.preventDefault(); }); // 防止抢走输入框焦点
    pill.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      toggleRecording('click');
    });
  }

  function showBubble(text, hint, isErr) {
    if (!bubble) return;
    bubble.className = 'vi-bubble show' + (isErr ? ' err' : '');
    bubble.textContent = text || '';
    if (hint) {
      var h = document.createElement('div');
      h.className = 'vi-hint';
      h.textContent = hint;
      bubble.appendChild(h);
    }
    bubble.scrollTop = bubble.scrollHeight; // 内容更新后始终显示最新文字
  }
  function hideBubble() { if (bubble) bubble.className = 'vi-bubble'; }
  function setPillState(state) {
    if (!pill) return;
    pill.classList.toggle('rec', state === 'connecting' || state === 'recording');
    pill.classList.toggle('err', state === 'err');
    var mic = pill.firstChild;
    if (mic) mic.textContent = state === 'err' ? '⚠' : '🎤';
  }

  // ---------- 吸附定位 ----------
  function visible(el) {
    var r = el.getBoundingClientRect();
    if (r.width < 60 || r.height < 14) return false;
    if (r.top < 0 || r.bottom > innerHeight + 60) return false;
    var s = getComputedStyle(el);
    return s.visibility !== 'hidden' && s.display !== 'none' && s.pointerEvents !== 'none';
  }
  function findComposer() {
    var best = null, bestBottom = -1;
    var els = document.querySelectorAll('textarea, [contenteditable="true"], [role="textbox"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.closest && el.closest('#vi-root')) continue;
      if (!visible(el)) continue;
      var b = el.getBoundingClientRect().bottom;
      if (b > bestBottom) { bestBottom = b; best = el; }
    }
    return best;
  }
  function reposition() {
    if (!root) return;
    composer = findComposer();
    if (!composer || !cfg || !cfg.url) { root.style.display = 'none'; return; }
    var r = composer.getBoundingClientRect();
    root.style.display = 'block';
    var left = Math.min(r.right - 40, innerWidth - 44);
    var top = r.top - 40;
    if (top < 6) top = Math.min(r.bottom + 6, innerHeight - 40); // 输入框贴顶时放下方
    root.style.left = Math.max(6, left) + 'px';
    root.style.top = Math.max(6, top) + 'px';
  }

  // ---------- 文本插入（输入法式：插入光标处，不发送） ----------
  function insertText(text) {
    var el = findComposer() || composer;
    if (!el) return false;
    try {
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        var s = el.selectionStart == null ? el.value.length : el.selectionStart;
        var e2 = el.selectionEnd == null ? s : el.selectionEnd;
        setter.call(el, el.value.slice(0, s) + text + el.value.slice(e2));
        var pos = s + text.length;
        el.setSelectionRange(pos, pos);
      } else {
        document.execCommand('insertText', false, text);
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    } catch (e) {
      return false;
    }
  }

  // ---------- 音频管线（与 panel.js 相同：16k 单声道 Int16 PCM） ----------
  var WORKLET_SRC =
    'class PcmCapture extends AudioWorkletProcessor{' +
    'constructor(){super();this._buf=new Int16Array(2048);this._len=0;}' +
    'process(inputs){var input=inputs[0];var ch=input&&input[0];if(!ch)return true;' +
    'for(var i=0;i<ch.length;i++){var s=Math.max(-1,Math.min(1,ch[i]));' +
    'this._buf[this._len++]=s<0?s*0x8000:s*0x7fff;' +
    'if(this._len===this._buf.length){this.port.postMessage(this._buf.slice(0,this._len));this._len=0;}}' +
    'return true;}}registerProcessor("pcm-capture",PcmCapture);';

  function releaseAudio() {
    try {
      if (workletNode) workletNode.disconnect();
      if (sourceNode) sourceNode.disconnect();
      if (mediaStream) for (var i = 0; i < mediaStream.getTracks().length; i++) mediaStream.getTracks()[i].stop();
      if (audioContext && audioContext.state !== 'closed') audioContext.close();
    } catch (e) {}
    workletNode = sourceNode = mediaStream = audioContext = null;
  }

  function startAudio() {
    return navigator.mediaDevices
      .getUserMedia({
        audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
      })
      .then(function (stream) {
        mediaStream = stream;
        audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
        if (audioContext.state === 'suspended') return audioContext.resume().then(function () { return stream; });
        return stream;
      })
      .then(function () {
        sourceNode = audioContext.createMediaStreamSource(mediaStream);
        var blob = new Blob([WORKLET_SRC], { type: 'application/javascript' });
        var url = URL.createObjectURL(blob);
        return audioContext.audioWorklet.addModule(url).then(function () {
          URL.revokeObjectURL(url);
          workletNode = new AudioWorkletNode(audioContext, 'pcm-capture');
          workletNode.port.onmessage = function (ev) { sendAudio(ev.data); };
          sourceNode.connect(workletNode); // 不连 destination，避免回放
        });
      });
  }

  // ---------- 中继客户端 ----------
  function sendAudio(buf) {
    if (ws && ws.readyState === 1) ws.send(buf);
  }

  function connectRelay() {
    return new Promise(function (resolve, reject) {
      ws = new WebSocket(cfg.url);
      ws.binaryType = 'arraybuffer';
      var settled = false;
      ws.onopen = function () {
        var s = (cfg && cfg.settings) || {};
        ws.send(
          JSON.stringify({
            type: 'hello',
            token: cfg.token,
            mode: 'sentence',
            sampleRate: SAMPLE_RATE,
            settings: {
              enablePunc: s.enablePunc !== false,
              enableItn: s.enableItn !== false,
              enableDdc: s.enableDdc === true,
              addPunctuation: s.addPunctuation === true,
              cleanRepeat: s.cleanRepeat === true,
              applyCaseFix: s.applyCaseFix === true,
              includeBuiltinTerms: s.includeBuiltinTerms !== false,
            },
            dictionary: [],
          })
        );
      };
      ws.onmessage = function (ev) {
        var msg;
        try {
          msg = JSON.parse(typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data));
        } catch (e) {
          return;
        }
        if (msg.type === 'ready') {
          settled = true;
          resolve();
        } else if (msg.type === 'partial') {
          lastPartial = msg.text || '';
          showBubble(lastPartial || '（聆听中…）', escHint(), false);
        } else if (msg.type === 'final') {
          onFinal(msg.text || '');
        } else if (msg.type === 'error') {
          if (!settled) reject(new Error(msg.message || '中继错误'));
          else fail(msg.message || '识别失败');
        } else if (msg.type === 'cancelled') {
          reset('已取消');
        }
      };
      ws.onerror = function () {
        if (!settled) reject(new Error('无法连接本地语音中继'));
      };
      ws.onclose = function () {
        if (!settled) reject(new Error('本地中继连接关闭'));
      };
      setTimeout(function () {
        if (!settled) reject(new Error('连接中继超时（语音服务未就绪？）'));
      }, 6000);
    });
  }
  function closeWs() {
    if (ws) {
      try { ws.close(1000); } catch (e) {}
      ws = null;
    }
    wsReady = false;
  }

  function escHint() {
    return beginMode === 'ptt' ? '' : 'Esc 取消';
  }

  // ---------- 录音状态机 ----------
  function begin(mode) {
    if (st !== 'idle') return;
    if (!cfg || !cfg.url || !cfg.token) { flashErr('语音服务未就绪（先启用插件并重启 ZCode）'); return; }
    st = 'connecting';
    beginMode = mode;
    startedAt = Date.now();
    lastPartial = '';
    setPillState('connecting');
    showBubble('（连接中…）', escHint(), false);
    connectRelay()
      .then(function () {
        wsReady = true;
        return startAudio();
      })
      .then(function () {
        if (st !== 'connecting') throw new Error('cancelled');
        st = 'recording';
        setPillState('recording');
        showBubble('（聆听中…）', escHint(), false);
      })
      .catch(function (e) {
        if (st === 'connecting') {
          releaseAudio();
          closeWs();
          fail(e && e.message ? e.message : '启动录音失败');
        }
      });
  }

  function finish() {
    if (st === 'connecting') { cancel(); return; } // 还没就绪：视作取消
    if (st !== 'recording') return;
    var held = Date.now() - startedAt;
    if (held < MIN_MS) { cancel('太短，已忽略'); return; }
    st = 'finishing';
    releaseAudio();
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'stop' })); } catch (e) { fail('发送结束指令失败'); }
    } else {
      fail('与语音服务的连接已中断');
    }
  }

  function cancel(reason) {
    if (st === 'idle') return;
    releaseAudio();
    if (ws && ws.readyState === 1) {
      try { ws.send(JSON.stringify({ type: 'cancel' })); } catch (e) {}
    }
    closeWs();
    reset(reason || '已取消');
  }

  function onFinal(text) {
    closeWs();
    st = 'idle';
    setPillState('idle');
    if (!text) {
      showBubble('没有识别到内容，请靠近麦克风重试', '', true);
      setTimeout(hideBubble, 2500);
      return;
    }
    if (insertText(text)) {
      showBubble(text, '已插入 ✓', false);
    } else {
      try { navigator.clipboard.writeText(text); } catch (e) {}
      showBubble(text, '已复制，请粘贴', false);
    }
    setTimeout(hideBubble, 2000);
  }

  function fail(msg) {
    releaseAudio();
    closeWs();
    st = 'idle';
    setPillState('err');
    showBubble(String(msg), '', true);
    setTimeout(function () { setPillState('idle'); hideBubble(); }, 3200);
  }
  function flashErr(msg) {
    setPillState('err');
    showBubble(msg, '', true);
    setTimeout(function () { setPillState('idle'); hideBubble(); }, 2800);
  }
  function reset(msg) {
    closeWs();
    st = 'idle';
    setPillState('idle');
    if (msg) { showBubble(msg, '', false); setTimeout(hideBubble, 1200); }
    else hideBubble();
  }

  function toggleRecording(mode) {
    if (st === 'idle') begin(mode);
    else if (st === 'recording' || st === 'connecting') finish();
  }

  // ---------- 全局按键 ----------
  function onKeyDown(e) {
    if (!cfg) return;
    if (matchCombo(e, pttCombo)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat && st === 'idle') begin('ptt');
      return;
    }
    if (matchCombo(e, toggleCombo)) {
      e.preventDefault();
      e.stopPropagation();
      if (!e.repeat) toggleRecording('toggle');
      return;
    }
    if (e.key === 'Escape' && (st === 'recording' || st === 'connecting' || st === 'finishing')) {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }
  function onKeyUp(e) {
    if (!cfg) return;
    if (matchCombo(e, pttCombo) && beginMode === 'ptt') finish();
  }

  // ---------- 生命周期 ----------
  function tick() {
    if (st === 'recording' && Date.now() - startedAt > MAX_MS) finish();
    reposition();
  }

  function applyConfig(next) {
    cfg = next || null;
    pttCombo = cfg ? parseCombo(cfg.pttKey || 'F8') : null;
    toggleCombo = cfg ? parseCombo(cfg.toggleKeys || 'Ctrl+Shift+Space') : null;
    if (pill && cfg) {
      pill.title =
        '语音输入：单击开始/结束；按住 ' + keyLabel(cfg.pttKey) + ' 说话松开插入；' +
        keyLabel(cfg.toggleKeys) + ' 切换；Esc 取消';
    }
    if (cfg && cfg.url && cfg.token) reposition();
    else if (root) root.style.display = 'none';
  }

  function install(nextCfg) {
    if (!document.body) {
      // 极端时序：body 未就绪则稍后重试
      setTimeout(function () { install(nextCfg); }, 300);
      return;
    }
    buildDom();
    applyConfig(nextCfg);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('resize', reposition);
    if (typeof MutationObserver !== 'undefined') {
      observer = new MutationObserver(function () { reposition(); });
      observer.observe(document.body, { childList: true, subtree: true });
    }
    if (!repositionTimer) repositionTimer = setInterval(tick, 1000);
  }

  function teardown() {
    try { cancel(); } catch (e) {}
    if (repositionTimer) { clearInterval(repositionTimer); repositionTimer = 0; }
    if (observer) { try { observer.disconnect(); } catch (e) {} observer = null; }
    window.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('keyup', onKeyUp, true);
    window.removeEventListener('resize', reposition);
    releaseAudio();
    closeWs();
    var s = document.getElementById('vi-style');
    if (s) s.remove();
    if (root) { root.remove(); root = null; pill = null; bubble = null; }
    cfg = null;
  }

  window.__viRoot = {
    version: 1,
    install: install,
    runtime: applyConfig,
    teardown: teardown,
  };
})();
