#!/usr/bin/env node
// install-overlay.mjs — 安装/卸载主窗口语音输入录音条（修改客户端 app.asar）
//
// 用法：
//   node scripts/install-overlay.mjs              # 安装（幂等；自动替换旧注入行）
//   node scripts/install-overlay.mjs uninstall    # 卸载（仅剥离本插件注入行）
//   node scripts/install-overlay.mjs status       # 查看注入状态
//   node scripts/install-overlay.mjs --asar <path> ...  # 指定 app.asar 位置
//   node scripts/install-overlay.mjs --finalize-swap <asar> <tmp>  # 内部：等待客户端退出后替换
//
// 原理（与 zcode-token-usage-statusbar 同路线，已在同一客户端验证可行）：
//   app.asar 入口 out/main/index.js 尾部追加一行 dynamic import 加载
//   ~/.zcode/zcode-voice-input/inject-main.cjs（运行目录独立于插件缓存，升级插件不破坏注入）。
//   客户端运行中时 asar 被占用：先写 .voice.tmp，再派生后台进程等客户端退出后自动替换。
// 本脚本不做任何网络请求；仅读写本机文件。
'use strict';

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync, statSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ENTRY,
  INJECT_LINE_RE,
  injectLineFor,
  readHeader,
  iterFiles,
  readFileInAsar,
  repackAsar,
} from './lib/asar-patch.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = join(scriptDir, '..', 'plugin');
const RUNTIME_DIR = join(homedir(), '.zcode', 'zcode-voice-input');
const LOADER = join(RUNTIME_DIR, 'inject-main.cjs');

// ---------- 参数 ----------
const argv = process.argv.slice(2);
let mode = 'install';
if (argv[0] === 'uninstall' || argv[0] === 'status') mode = argv[0];
const asarArgIdx = argv.indexOf('--asar');
const asarArg = asarArgIdx >= 0 ? argv[asarArgIdx + 1] : null;
const finalizeIdx = argv.indexOf('--finalize-swap');

function findAsar() {
  if (asarArg) return asarArg;
  if (process.env.ZCODE_ASAR) return process.env.ZCODE_ASAR;
  const candidates = [];
  if (process.platform === 'win32') {
    for (const root of [process.env.ProgramFiles, 'D:\\Program Files', 'D:\\', process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Programs')]) {
      if (root) candidates.push(join(root, 'ZCode', 'resources', 'app.asar'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/ZCode.app/Contents/Resources/app.asar');
  } else {
    candidates.push('/opt/ZCode/resources/app.asar', '/usr/lib/zcode/resources/app.asar');
  }
  for (const p of candidates) if (p && existsSync(p)) return p;
  return null;
}

function log(msg) {
  console.log(msg);
}

// ---------- 校验 ----------
function verifyTmp(tmp, expectLine) {
  const { header } = readHeader(tmp); // 头可解析
  const n = iterFiles(header).length;
  const entry = readFileInAsar(tmp, ENTRY);
  const has = entry.includes('voice-input] load failed');
  if (expectLine && !has) throw new Error('自检失败：注入行缺失');
  if (!expectLine && has) throw new Error('自检失败：卸载后仍存在注入行');
  return { files: n };
}

/** 用客户端自身（ELECTRON_RUN_AS_NODE）对改后的入口做语法检查；尽力而为，不阻塞安装 */
function syntaxCheck(asarPath, exeDir) {
  const exe = process.platform === 'win32' ? join(exeDir, 'ZCode.exe') : join(exeDir, 'ZCode');
  if (!existsSync(exe)) return true;
  const entry = readFileInAsar(asarPath, ENTRY);
  const tmpJs = join(RUNTIME_DIR, '.entry-check.js');
  writeFileSync(tmpJs, entry);
  try {
    const r = spawnSync(exe, ['--check', tmpJs], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      timeout: 15000,
      encoding: 'utf8',
      windowsHide: true,
    });
    if (r.status !== 0) {
      log(`  [check] 语法检查失败:\n${String(r.stderr || '').slice(0, 500)}`);
      return false;
    }
    log('  [check] 入口语法检查通过');
    return true;
  } catch {
    return true; // 无法执行则跳过
  } finally {
    try { rmSync(tmpJs, { force: true }); } catch {}
  }
}

// ---------- 替换（含运行中收尾） ----------
function trySwap(asar, tmp) {
  try {
    renameSync(tmp, asar);
    return true;
  } catch (e) {
    if (e && (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EAGAIN')) return false;
    throw e;
  }
}

function spawnFinalizer(asar, tmp) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--finalize-swap', asar, tmp], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
}

function finalizeSwapMain() {
  const asar = argv[finalizeIdx + 1];
  const tmp = argv[finalizeIdx + 2];
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  (function poll() {
    if (trySwap(asar, tmp)) {
      try { verifyTmp(asar, true); } catch {}
      return;
    }
    if (Date.now() > deadline) {
      try { rmSync(tmp, { force: true }); } catch {}
      return;
    }
    setTimeout(poll, 2000);
  })();
}

// ---------- 主流程 ----------
async function main() {
  if (finalizeIdx >= 0) {
    finalizeSwapMain();
    return;
  }

  const asar = findAsar();
  if (!asar) {
    log('未找到 ZCode 的 app.asar。请用 --asar <路径> 指定，例如：');
    log('  node scripts/install-overlay.mjs --asar "D:\\Program Files\\ZCode\\resources\\app.asar"');
    process.exit(1);
  }
  log(`目标: ${asar}`);

  if (mode === 'status') {
    const entry = readFileInAsar(asar, ENTRY).toString('utf8');
    const m = entry.match(INJECT_LINE_RE);
    log(m ? `已安装（注入行 → ${m[0].slice(0, 120)}…）` : '未安装');
    log(`运行目录: ${RUNTIME_DIR}（存在: ${existsSync(LOADER)}）`);
    return;
  }

  // 1) 同步 overlay 文件到运行目录
  mkdirSync(RUNTIME_DIR, { recursive: true });
  for (const name of ['overlay.js', 'inject-main.cjs']) {
    copyFileSync(join(pluginRoot, 'overlay', name), join(RUNTIME_DIR, name));
  }
  log(`已同步 overlay 文件 → ${RUNTIME_DIR}`);

  // 2) 计算新入口内容
  const entryStr = readFileInAsar(asar, ENTRY).toString('utf8');
  const stripped = entryStr.replace(INJECT_LINE_RE, '');
  let next;
  if (mode === 'install') {
    const line = injectLineFor(pathToFileURL(LOADER).href);
    if (entryStr.includes(line)) {
      log('注入行已存在且指向当前运行目录，无需修改。');
      return;
    }
    next = Buffer.concat([Buffer.from(stripped, 'utf8'), Buffer.from(line, 'utf8')]);
  } else {
    if (stripped.length === entry.length) {
      log('未发现注入行，无需卸载。');
      return;
    }
    next = Buffer.from(stripped, 'utf8');
  }

  // 3) repack → 校验 → 替换（目录不可写时给出提权指引，不再进入等待替换流程）
  const probe = join(dirname(asar), '.voice-write-probe');
  try {
    writeFileSync(probe, '');
    rmSync(probe, { force: true });
  } catch (e) {
    log(`❌ 无权写入 ${dirname(asar)}（${e.code || e.message}）。请以管理员身份运行，例如 PowerShell 管理员：`);
    log(`   node "${fileURLToPath(import.meta.url)}"${asarArg ? '' : ` --asar "${asar}"`}`);
    process.exit(1);
  }
  const tmp = join(dirname(asar), 'app.asar.voice.tmp');
  rmSync(tmp, { force: true });
  const size = await repackAsar(asar, { [ENTRY]: next }, tmp);
  const { files } = verifyTmp(tmp, mode === 'install');
  log(`  [repack] ${basename(asar)} → 临时包 ${(size / 1048576).toFixed(1)} MB（${files} 个文件）`);

  if (trySwap(asar, tmp)) {
    syntaxCheck(asar, dirname(dirname(asar)));
    log(mode === 'install' ? '✅ 注入完成。完全退出并重启 ZCode 后生效（托盘右键退出，仅关窗口不算）。'
      : '✅ 注入已移除。完全退出并重启 ZCode 后生效。');
  } else {
    // 客户端运行中：后台等待退出后自动替换
    spawnFinalizer(asar, tmp);
    log('⏳ ZCode 正在运行，app.asar 被占用。已生成待替换包，将在客户端完全退出后自动完成替换（2 小时内有效）。');
    log('   请在方便时完全退出 ZCode（托盘右键退出），然后重新打开。');
  }
}

main().catch((e) => {
  console.error(`❌ ${mode} 失败: ${e.message}`);
  process.exit(1);
});
