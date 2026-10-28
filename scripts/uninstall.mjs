#!/usr/bin/env node
// uninstall.mjs — 卸载插件并（可选）移除本地市场。仅操作本插件，不触碰其他插件配置。
// 用法: node scripts/uninstall.mjs [--remove-market] [--zcode <路径>]
// CLI 定位同 install-local.mjs：--zcode 参数 > ZCODE_CLI 环境变量 > 常见路径自动搜索
'use strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir, platform } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const MARKET_NAME = 'dev-zcode-voice-input-local';
const PLUGIN_ID = `zcode-voice-input@${MARKET_NAME}`;
const rel = 'resources/glm/zcode.cjs';

function findCli() {
  const i = args.indexOf('--zcode');
  if (i !== -1 && args[i + 1] && existsSync(args[i + 1])) return args[i + 1];
  if (process.env.ZCODE_CLI && existsSync(process.env.ZCODE_CLI)) return process.env.ZCODE_CLI;
  const candidates = [];
  if (platform() === 'win32') {
    for (const d of ['C', 'D', 'E']) candidates.push(`${d}:\\Program Files\\ZCode\\${rel.replaceAll('/', '\\')}`);
    if (process.env.LOCALAPPDATA) candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'ZCode', 'resources', 'glm', 'zcode.cjs'));
  } else {
    for (const base of ['/usr/share/zcode', '/usr/lib/zcode', '/opt/zcode', join(homedir(), '.local/share/zcode'), join(homedir(), '.local/share/ZCode'), '/snap/zcode/current']) {
      candidates.push(join(base, rel));
    }
    try {
      for (const name of readdirSync('/opt')) if (/zcode/i.test(name)) candidates.push(join('/opt', name, rel));
    } catch {}
  }
  return candidates.find((c) => existsSync(c)) || null;
}

const zcodeCli = findCli();
if (!zcodeCli) {
  console.error('未找到 zcode CLI。请在 ZCode 图形界面：设置 → 插件 → 卸载；或用 --zcode 指定路径。');
  process.exit(2);
}
const zcode = (a2) => {
  console.log(`$ zcode ${a2.join(' ')}`);
  try {
    return execFileSync('node', [zcodeCli, ...a2], { encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    console.log(`（命令失败：${String(e.stdout || e.stderr || e.message).slice(0, 200)}）`);
    return '';
  }
};

zcode(['plugins', 'uninstall', PLUGIN_ID, '--scope', 'user', '--force']);
if (args.includes('--remove-market')) {
  zcode(['plugins', 'marketplace', 'remove', MARKET_NAME, '--scope', 'user', '--force']);
}
const list = zcode(['plugins', 'list', '--json']);
console.log(list.includes('zcode-voice-input') ? '警告：插件仍在列表中' : '✅ 插件已卸载。重启 ZCode 生效。');
try {
  appendFileSync(join(root, 'INSTALL_LOG.md'), `- [${new Date().toISOString()}] uninstall executed\n`);
} catch {}
