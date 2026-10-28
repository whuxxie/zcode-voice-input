#!/usr/bin/env node
// build-package.mjs — 生成可分发插件包（zip），并校验包内结构
'use strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pluginName = 'zcode-voice-input';
const manifest = JSON.parse(readFileSync(join(root, 'plugin/.zcode-plugin/plugin.json'), 'utf8'));
const version = manifest.version;
const staging = join(dist, pluginName);
const zipPath = join(dist, `${pluginName}-v${version}.zip`);
// 本地市场根目录（官方布局：marketplace.json 与 plugins/<name>/ 同级）
const marketRoot = join(dist, 'local-marketplace');
const marketStaging = join(marketRoot, 'plugins', pluginName);

rmSync(dist, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(marketStaging, { recursive: true });

// 1) 构建面板（确保最新）
execFileSync('node', [join(root, 'scripts', 'build-panel.mjs')], { stdio: 'inherit' });

// 2) 收集安装所需文件
const files = [
  ['.zcode-plugin/plugin.json', true],
  ['server/package.json', true],
  ['server/server.mjs', true],
  ['server/backend-factory.mjs', true],
  ['server/volcano-protocol.js', true],
  ['server/volcano-asr.js', true],
  ['server/relay.js', true],
  ['server/mock-asr.js', true],
  ['server/term-processor.js', true],
  ['server/runtime-publisher.mjs', true],
  ['overlay/overlay.js', true],
  ['overlay/inject-main.cjs', true],
  ['panel/panel.html', true],
  ['skills/voice-input/SKILL.md', true],
  ['README.md', true],
  ['LICENSE', false],
];
for (const [rel, required] of files) {
  const src = join(root, 'plugin', rel);
  if (!existsSync(src)) {
    if (required) {
      console.error(`缺少必需文件: ${rel}`);
      process.exit(1);
    }
    continue;
  }
  const dest = join(staging, rel);
  mkdirSync(dirname(dest), { recursive: true });
  const content = readFileSync(src);
  // 校验不把密钥打进包
  if (/ZCODE_VOICE_ACCESS_KEY_SECRET|BEGIN (RSA|EC) PRIVATE KEY/.test(content.toString('utf8'))) {
    console.error(`文件 ${rel} 疑似包含私钥/密钥，拒绝打包`);
    process.exit(1);
  }
  writeFileSync(dest, content);
  // 同步到本地市场布局
  const dest2 = join(marketStaging, rel);
  mkdirSync(dirname(dest2), { recursive: true });
  writeFileSync(dest2, content);
}

// 2.5) 生成本地市场清单（source 必须位于市场根目录之内）
const marketManifest = {
  name: 'dev-zcode-voice-input-local',
  owner: { name: 'ZCode Voice Input (local dev market)' },
  metadata: {
    description: 'ZCode Voice Input 本地开发市场：语音输入插件（火山引擎豆包流式语音识别 2.0）',
  },
  plugins: [
    {
      name: pluginName,
      source: `./plugins/${pluginName}`,
      version,
      description: manifest.description,
      displayName: 'ZCode Voice Input',
      displayName_i18n: { 'zh-CN': '语音输入', 'en-US': 'ZCode Voice Input' },
      description_i18n: {
        'zh-CN': manifest.description_i18n['zh-CN'] || manifest.description,
        'en-US': manifest.description_i18n.en || manifest.description,
      },
      category: 'productivity',
    },
  ],
};
writeFileSync(join(marketRoot, 'marketplace.json'), JSON.stringify(marketManifest, null, 2), 'utf8');

// 3) 打 zip（Windows: PowerShell Compress-Archive；其他: zip 命令）
try {
  if (process.platform === 'win32') {
    execFileSync('powershell', [
      '-NoProfile', '-Command',
      `Compress-Archive -Path "${staging}\\*" -DestinationPath "${zipPath}" -Force`,
    ], { stdio: 'inherit' });
  } else {
    execFileSync('zip', ['-r', zipPath, '.'], { cwd: staging, stdio: 'inherit' });
  }
} catch (e) {
  console.error('打包失败:', e.message);
  process.exit(1);
}

// 4) 校验 zip 内容
let listing;
if (process.platform === 'win32') {
  listing = execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::OpenRead("${zipPath}").Entries.FullName -join "\n"`,
  ]).toString();
} else {
  listing = execFileSync('unzip', ['-Z1', zipPath]).toString();
}
const entries = listing.split(/\r?\n/).filter(Boolean).map((e) => e.replaceAll('\\', '/'));
const need = ['.zcode-plugin/plugin.json', 'server/server.mjs', 'server/backend-factory.mjs', 'panel/panel.html'];
for (const n of need) {
  if (!entries.some((e) => e === n || e.endsWith('/' + n))) {
    console.error(`zip 缺少 ${n}。实际内容:\n${entries.join('\n')}`);
    process.exit(1);
  }
}
const sha = createHash('sha256').update(readFileSync(zipPath)).digest('hex');
console.log(`打包完成: ${zipPath}`);
console.log(`条目数: ${entries.length}`);
console.log(`sha256: ${sha}`);
writeFileSync(join(dist, `${pluginName}-v${version}.sha256`), sha + '\n', 'utf8');
