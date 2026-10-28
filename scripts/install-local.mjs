#!/usr/bin/env node
// install-local.mjs — 通过 ZCode CLI 注册本地市场并安装/启用插件（Windows / Linux 通用）
// 用法: node scripts/install-local.mjs [--zcode <zcode.cjs 路径>] [--skip-build]
// CLI 定位顺序: --zcode 参数 > ZCODE_CLI 环境变量 > 常见安装路径自动搜索
'use strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const logPath = join(root, 'INSTALL_LOG.md');
function log(s) {
  const line = `- [${new Date().toISOString()}] ${s}`;
  console.log(line);
  try {
    appendFileSync(logPath, line + '\n');
  } catch {}
}

function findCliCandidates() {
  const rel = ['resources', 'glm', 'zcode.cjs'].join('/');
  const p = platform();
  const out = [];
  if (p === 'win32') {
    for (const d of ['C', 'D', 'E']) out.push(`${d}:\\Program Files\\ZCode\\${rel.replaceAll('/', '\\')}`);
    const lad = process.env.LOCALAPPDATA;
    if (lad) out.push(join(lad, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    if (process.env['ProgramFiles(x86)']) out.push(join(process.env['ProgramFiles(x86)'], 'ZCode', 'resources', 'glm', 'zcode.cjs'));
    for (const d of ['C', 'D', 'E']) out.push(`${d}:\\ZCode\\${rel.replaceAll('/', '\\')}`);
  } else {
    // Linux：系统包 / tar 解压 / 用户级 / AppImage 解包目录
    out.push(`/usr/share/zcode/${rel}`);
    out.push(`/usr/lib/zcode/${rel}`);
    out.push(`/opt/zcode/${rel}`);
    out.push(join(homedir(), '.local/share/zcode', rel));
    out.push(join(homedir(), '.local/share/ZCode', rel));
    out.push(`/snap/zcode/current/${rel}`);
    try {
      for (const name of readdirSync('/opt')) {
        if (/zcode/i.test(name)) out.push(join('/opt', name, rel));
      }
    } catch {}
    try {
      for (const name of readdirSync('/usr/share')) {
        if (/^zcode/i.test(name)) out.push(join('/usr/share', name, rel));
      }
    } catch {}
  }
  return out;
}

function resolveZcodeCli() {
  const i = args.indexOf('--zcode');
  if (i !== -1 && args[i + 1]) {
    const p = args[i + 1];
    if (!existsSync(p)) {
      console.error(`--zcode 指定的路径不存在: ${p}`);
      process.exit(2);
    }
    return p;
  }
  if (process.env.ZCODE_CLI && existsSync(process.env.ZCODE_CLI)) return process.env.ZCODE_CLI;
  for (const c of findCliCandidates()) {
    if (existsSync(c)) return c;
  }
  return null;
}

const zcodeCli = resolveZcodeCli();
if (!zcodeCli) {
  console.error(
    '未找到 zcode CLI（resources/glm/zcode.cjs）。\n' +
      '处理方式（任选其一）：\n' +
      '  1) node scripts/install-local.mjs --zcode "<ZCode安装目录>/resources/glm/zcode.cjs"\n' +
      '  2) 设置环境变量 ZCODE_CLI 指向该文件\n' +
      '  3) 使用图形界面安装（见 README「方式 B」）：插件市场 → 添加 → 粘贴 dist/local-marketplace 绝对路径\n' +
      '也可先运行 node scripts/doctor.mjs 查看诊断。'
  );
  process.exit(2);
}
log(`使用 zcode CLI: ${zcodeCli}`);

function zcode(a2, { quiet = false } = {}) {
  log(`$ zcode ${a2.join(' ')}`);
  try {
    const out = execFileSync('node', [zcodeCli, ...a2], { encoding: 'utf8', timeout: 180000 });
    if (!quiet && out.trim()) log(out.trim().split('\n').slice(0, 12).join('\n'));
    return out;
  } catch (e) {
    const so = String((e.stdout || '') + (e.stderr || '')).slice(0, 400);
    log(`命令失败: ${so || e.message}`);
    throw e;
  }
}

const MARKET_DIR = join(root, 'dist', 'local-marketplace');
const MARKET_NAME = 'dev-zcode-voice-input-local';
const PLUGIN_ID = `zcode-voice-input@${MARKET_NAME}`;

// 0) 构建
if (!args.includes('--skip-build')) {
  execFileSync('node', [join(root, 'scripts', 'build-panel.mjs')], { stdio: 'inherit' });
  execFileSync('node', [join(root, 'scripts', 'build-package.mjs')], { stdio: 'inherit' });
}
if (!existsSync(join(MARKET_DIR, 'marketplace.json'))) {
  console.error(`缺少 ${MARKET_DIR}，请先 node scripts/build-package.mjs`);
  process.exit(1);
}

// 0.5) 幂等：移除同名旧市场注册（仅本市场，--force 供非交互 shell 使用）
try {
  zcode(['plugins', 'marketplace', 'remove', MARKET_NAME, '--scope', 'user', '--force'], { quiet: true });
} catch {}

// 1) 添加市场
try {
  zcode(['plugins', 'marketplace', 'add', MARKET_DIR, '--scope', 'user']);
} catch (e) {
  if (String(e.message).includes('already')) {
    log('市场已存在，继续安装');
  } else {
    console.error('添加市场失败。可改用图形界面安装（README 方式 B）。');
    process.exit(1);
  }
}

// 2) 安装（已装则先卸载再装，保证版本一致；--force 供非交互 shell）
try {
  zcode(['plugins', 'install', PLUGIN_ID, '--scope', 'user']);
} catch {
  log('直接安装失败，尝试先卸载再安装');
  try {
    zcode(['plugins', 'uninstall', PLUGIN_ID, '--scope', 'user', '--force'], { quiet: true });
  } catch {}
  zcode(['plugins', 'install', PLUGIN_ID, '--scope', 'user']);
}

// 3) 启用
try {
  zcode(['plugins', 'enable', PLUGIN_ID, '--scope', 'user']);
} catch {}

// 4) 校验
const finalList = zcode(['plugins', 'list', '--json'], { quiet: true });
const ok = finalList.includes('"zcode-voice-input@dev-zcode-voice-input-local"') || finalList.includes('zcode-voice-input');
log('--- 安装结果 ---');
log(ok ? '✅ 插件已出现在已安装列表（enabled）' : '⚠️ 未能在列表中确认插件，请查看上方输出');

const isWin = platform() === 'win32';
console.log('\n完成。下一步：');
console.log(`1. 完全退出并重启 ZCode（${isWin ? '托盘右键退出' : 'pkill zcode 或退出菜单'}）。`);
console.log('2. 新开会话 → 打开"语音输入 / Voice Input"面板。');
console.log('3. （可选）设置 → 插件 → ZCode Voice Input → 配置火山引擎凭据。');
