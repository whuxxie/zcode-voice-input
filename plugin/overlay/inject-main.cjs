// inject-main.cjs — ZCode Voice Input 主进程 loader
// 由 scripts/install-overlay.mjs 在 app.asar 入口（out/main/index.js）尾部追加一行
// dynamic import 加载（CJS，在 type:module 的 asar 入口里按 .cjs 正常 require）。
// 职责：
//   1) 把 runtime 目录（~/.zcode/zcode-voice-input/）里的 overlay.js 注入每个主窗口
//      （webContents.executeJavaScript；mtime 变化热更新，免重启）；
//   2) 轮询同目录 runtime.json（MCP 服务器写入的中继端口/token/按键配置），
//      变化后经 window.__viRuntime(cfg) 推给已注入窗口；
//   3) 窗口导航重载后自动补注入。
// 一切失败只写 stderr 日志，绝不让宿主崩溃。
'use strict';

const fs = require('fs');
const path = require('path');

let electron = null;
try {
  electron = require('electron');
} catch (e) {
  // 非 Electron 环境（误以 node 直接运行）
  console.error('[voice-input] not running inside Electron, exit.');
  return;
}
const { app, webContents } = electron;

const RUNTIME_DIR = path.join(app.getPath('home'), '.zcode', 'zcode-voice-input');
const OVERLAY = path.join(RUNTIME_DIR, 'overlay.js');
const RUNTIME_JSON = path.join(RUNTIME_DIR, 'runtime.json');

const LOG = (...a) => console.error('[voice-input]', ...a);

// U+2028/2029 在 JS 字符串字面量里非法，嵌入 executeJavaScript 前须转义
function jsonForEmbed(obj) {
  return JSON.stringify(obj).replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'));
}

let overlaySrc = '';
let overlayMtime = 0;
let cfg = null;
let cfgStamp = 0;

function statMtime(p) {
  try {
    return fs.statSync(p).mtimeMs;
  } catch (e) {
    return 0;
  }
}

function loadOverlay() {
  try {
    const src = fs.readFileSync(OVERLAY, 'utf8');
    // 语法预检：防止把写到一半的文件注入页面
    new Function(src);
    overlaySrc = src;
    overlayMtime = statMtime(OVERLAY);
    return true;
  } catch (e) {
    LOG('overlay.js unavailable:', e.message);
    return false;
  }
}

function loadCfg() {
  try {
    const txt = fs.readFileSync(RUNTIME_JSON, 'utf8');
    const obj = JSON.parse(txt);
    if (obj && typeof obj === 'object' && obj.url && obj.token) {
      cfg = obj;
      cfgStamp = statMtime(RUNTIME_JSON);
      return;
    }
  } catch (e) {}
  cfg = null; // 语音服务不可用：overlay 自行隐藏
  cfgStamp = statMtime(RUNTIME_JSON);
}

function isMainWindow(wc) {
  try {
    return !wc.isDestroyed() && wc.getType() === 'window';
  } catch (e) {
    return false;
  }
}

function allWindows() {
  return webContents.getAllWebContents().filter(isMainWindow);
}

function injectInto(wc) {
  if (!overlaySrc) return;
  wc.executeJavaScript(overlaySrc, true)
    .then(() => {
      if (cfg) {
        return wc.executeJavaScript(`window.__viRoot && window.__viRoot.install(${jsonForEmbed(cfg)})`, true);
      }
    })
    .catch((e) => LOG('inject failed:', e && e.message));
}

function pushCfg(wc) {
  if (!cfg) return;
  wc.executeJavaScript(`window.__viRoot && window.__viRoot.runtime(${jsonForEmbed(cfg)})`, true).catch(() => {});
}

function ensureInjected() {
  for (const wc of allWindows()) {
    wc.executeJavaScript('!!window.__viRoot', true)
      .then((has) => {
        if (!has) injectInto(wc);
        else pushCfg(wc);
      })
      .catch(() => {});
  }
}

function hotReloadOverlay() {
  for (const wc of allWindows()) {
    wc.executeJavaScript('window.__viRoot && window.__viRoot.teardown()', true)
      .catch(() => {})
      .then(() => injectInto(wc));
  }
}

loadOverlay();
loadCfg();

// 启动即扫一遍 + 新窗口事件；轮询兜底（页面导航后 __viRoot 会消失）
try {
  app.on('browser-window-created', (_e, win) => {
    try {
      win.webContents.on('did-finish-load', () => ensureInjected());
    } catch (e) {}
  });
} catch (e) {
  LOG('browser-window-created hook failed:', e.message);
}

setInterval(() => {
  try {
    const om = statMtime(OVERLAY);
    if (om && om !== overlayMtime) {
      if (loadOverlay()) hotReloadOverlay();
      return;
    }
    const cm = statMtime(RUNTIME_JSON);
    if (cm !== cfgStamp) {
      loadCfg();
      for (const wc of allWindows()) pushCfg(wc);
    }
    ensureInjected();
  } catch (e) {
    LOG('poll error:', e && e.message);
  }
}, 2500);

LOG('loader active; runtime dir:', RUNTIME_DIR, 'overlay:', !!overlaySrc, 'cfg:', !!cfg);
