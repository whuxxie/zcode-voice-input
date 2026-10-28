#!/usr/bin/env node
// build-panel.mjs — 生成自包含 panel.html（内联 ext-apps SDK + 面板逻辑）
// 面板在 zcode-sandbox 沙箱中以 srcdoc/注入方式加载，相对路径资源不可用，必须单文件内联。
'use strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const template = readFileSync(join(root, 'plugin/panel/src/panel.html'), 'utf8');
const vendor = readFileSync(join(root, 'plugin/panel/vendor/ext-apps.mjs'), 'utf8');
const stateMachine = readFileSync(join(root, 'plugin/panel/src/state-machine.js'), 'utf8');
const panelJsRaw = readFileSync(join(root, 'plugin/panel/src/panel.js'), 'utf8');
const panelJs = `const SM = (() => {\n${stateMachine}\nreturn { STATES, canStart, canStop, canCancel, canUseResult, canTransition };\n})();\n` + panelJsRaw;

// 安全检查：内联脚本不能包含 </script>，且不能意外包含占位符
if (panelJs.includes('</' + 'script') || vendor.includes('</' + 'script')) {
  console.error('panel.js 或 vendor 含有 </script>，请改写该字符串');
  process.exit(1);
}
if (panelJs.includes('__VENDOR_MJS__') || vendor.includes('__PANEL_JS__')) {
  console.error('源文件包含构建占位符，拒绝构建');
  process.exit(1);
}

// export { OO as App } 的外部名不产生局部绑定，追加的全局赋值必须用局部名（否则求值时 ReferenceError，
// 表现为面板 E_INIT「SDK 缺失」）。构建期从 export 表唯一定位局部名，re-vendor 后依然稳健。
const appExportMatches = [...vendor.matchAll(/([A-Za-z0-9_$]+)\s+as\s+App\b(?=[,}])/g)];
if (appExportMatches.length !== 1) {
  console.error(`无法在 vendor 导出表中唯一定位 App（匹配 ${appExportMatches.length} 处），拒绝构建`);
  process.exit(1);
}
const appLocal = appExportMatches[0][1];

// SDK 直接内联为前置 module script；运行时 import('data:') 会被宿主 CSP 的 script-src 拦截。
// replace 必须传函数：esbuild 产物含 $$/$& 等序列，字符串替换会被改写。
const html = template
  .replace('__VENDOR_MJS__', () => vendor + `\nwindow.__EXT_APPS__ = { App: ${appLocal} };`)
  .replace('/*__PANEL_JS__*/', () => panelJs);

const out = join(root, 'plugin/panel/panel.html');
writeFileSync(out, html, 'utf8');
console.log(`built ${out} (${(html.length / 1024).toFixed(0)} KB)`);
