#!/usr/bin/env node
// doctor.mjs — 环境体检：安装前的自检（Windows / Linux 通用）
// 检查：Node 版本、zcode CLI 定位、插件清单、面板构建产物、npm 测试依赖、平台音频栈提示
'use strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform, release } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rel = 'resources/glm/zcode.cjs';
const isWin = platform() === 'win32';
let failures = 0;

function ok(msg) {
  console.log(`  ✅ ${msg}`);
}
function warn(msg) {
  console.log(`  ⚠️  ${msg}`);
}
function fail(msg, hint) {
  failures++;
  console.log(`  ❌ ${msg}`);
  if (hint) console.log(`     → ${hint}`);
}
function section(t) {
  console.log(`\n== ${t} ==`);
}

console.log(`ZCode Voice Input 环境体检 / doctor`);
console.log(`平台: ${platform()} ${release()} (${process.arch})  Node: ${process.version}`);

// 1) Node 版本
section('Node.js');
{
  const [maj] = process.version.slice(1).split('.').map(Number);
  if (maj >= 22) ok(`Node ${process.version} ≥ 22`);
  else fail(`Node ${process.version} < 22`, '插件 MCP 服务器需要全局 WebSocket（Node ≥ 22）。Ubuntu 建议 nvm install 22；Windows 官网安装 LTS/Current。');
}

// 2) zcode CLI
section('ZCode CLI (resources/glm/zcode.cjs)');
let cli = null;
{
  const candidates = [];
  if (isWin) {
    for (const d of ['C', 'D', 'E']) candidates.push(`${d}:\\Program Files\\ZCode\\${rel.replaceAll('/', '\\')}`);
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    for (const d of ['C', 'D', 'E']) candidates.push(`${d}:\\ZCode\\${rel.replaceAll('/', '\\')}`);
  } else {
    for (const base of ['/usr/share/zcode', '/usr/lib/zcode', '/opt/zcode', join(homedir(), '.local/share/zcode'), join(homedir(), '.local/share/ZCode'), '/snap/zcode/current']) {
      candidates.push(join(base, rel));
    }
    try {
      for (const name of readdirSync('/opt')) if (/zcode/i.test(name)) candidates.push(join('/opt', name, rel));
    } catch {}
    try {
      for (const name of readdirSync('/usr/share')) if (/^zcode/i.test(name)) candidates.push(join('/usr/share', name, rel));
    } catch {}
  }
  cli = candidates.find((c) => existsSync(c));
  if (process.env.ZCODE_CLI && existsSync(process.env.ZCODE_CLI)) cli = process.env.ZCODE_CLI;
  if (cli) ok(`找到: ${cli}`);
  else warn('未自动找到 zcode CLI', '不影响图形界面安装。若用脚本安装：--zcode <路径> 或 ZCODE_CLI 环境变量。Linux 上也可用 `which zcode` 确认是否已有全局命令。');
}

// 3) CLI 版本与官方校验
if (cli) {
  section('插件清单（官方 validate）');
  try {
    const out = execFileSync('node', [cli, 'plugins', 'validate', join(root, 'plugin')], { encoding: 'utf8', timeout: 120000 });
    if (/valid/i.test(out)) ok(out.trim().split('\n')[0]);
    else warn(out.trim().slice(0, 200));
  } catch (e) {
    const so = String(e.stdout || e.stderr || e.message);
    if (/valid/i.test(so)) ok('Plugin manifest is valid');
    else fail('官方校验未通过', so.slice(0, 300));
  }
}

// 4) 清单关键结构与凭据注入
section('插件清单结构');
{
  try {
    const m = JSON.parse(readFileSync(join(root, 'plugin', '.zcode-plugin', 'plugin.json'), 'utf8'));
    const serverNames = Object.keys(m.mcpServers || {});
    if (m.ui?.surfaces?.[0]?.resourceUri && serverNames.length) ok(`UI surface + MCP server (${serverNames.join(', ')})`);
    else fail('清单缺少 ui.surfaces 或 mcpServers');
    const env = m.mcpServers[serverNames[0]]?.env || {};
    if (Object.keys(env).length) ok(`凭据经 userConfig 注入: ${Object.keys(env).join(', ')}`);
    else warn('MCP 服务器未声明 env 注入');
  } catch (e) {
    fail('清单读取失败: ' + e.message);
  }
}

// 5) 面板构建产物
section('面板构建产物');
{
  const p = join(root, 'plugin', 'panel', 'panel.html');
  if (!existsSync(p)) {
    fail('panel.html 不存在', '运行 node scripts/build-panel.mjs');
  } else {
    const size = statSync(p).size;
    if (size > 300 * 1024) ok(`panel.html ${(size / 1024).toFixed(0)} KB（自包含）`);
    else warn('panel.html 偏小，可能未完整构建', '运行 node scripts/build-panel.mjs');
  }
}

// 6) 本地市场产物
section('本地市场');
{
  const mk = join(root, 'dist', 'local-marketplace', 'marketplace.json');
  if (existsSync(mk)) ok('dist/local-marketplace/marketplace.json 存在');
  else warn('尚未构建本地市场', '运行 node scripts/build-package.mjs（install-local.mjs 会自动构建）');
}

// 7) 测试依赖（可选）
section('开发/测试依赖（可选）');
{
  if (existsSync(join(root, 'node_modules', 'ws'))) ok('ws 已安装（可跑完整测试）');
  else warn('未 npm install（不影响插件运行；跑测试需 npm install）');
}

// 8) 平台音频提示
section('音频栈（提示性）');
if (isWin) {
  ok('Windows: Chromium/WASAPI，无需额外配置；首次录音允许系统麦克风隐私权限');
} else {
  ok('Ubuntu: Chromium/PipeWire-PulseAudio；首次录音允许桌面门户权限');
  warn('Wayland 会话若无法弹权限提示，确认 xdg-desktop-portal 正在运行');
}

console.log(`\n结论: ${failures === 0 ? '✅ 未发现阻断问题，可以安装（node scripts/install-local.mjs）' : `❌ ${failures} 项需要先处理（见上方 → 提示）`}`);
process.exit(failures === 0 ? 0 : 1);
