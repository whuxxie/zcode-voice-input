// 测试 13/14：安装包独立启动 + 安装/卸载脚本能力
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'plugin', '.zcode-plugin', 'plugin.json'), 'utf8'));
const zip = join(root, 'dist', `zcode-voice-input-v${manifest.version}.zip`);

function extractZip(zipPath, dest) {
  if (process.platform === 'win32') {
    execFileSync('powershell', ['-NoProfile', '-Command',
      `Expand-Archive -Path "${zipPath}" -DestinationPath "${dest}" -Force`]);
  } else {
    execFileSync('unzip', ['-o', zipPath, '-d', dest]);
  }
}

function spawnServer(cwd) {
  const child = spawn('node', [join(cwd, 'server', 'server.mjs')], {
    cwd,
    env: {
      ...process.env,
      ZCODE_PLUGIN_DATA: join(cwd, 'data'),
      // runtime.json/overlay 同步目录也重定向，避免测试污染真实 ~/.zcode
      ZCODE_VOICE_RUNTIME_DIR: join(cwd, 'runtime'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let buf = '';
  child.stdout.on('data', (d) => (buf += d));
  child.stderr.on('data', () => {});
  const lines = [];
  const pump = setInterval(() => {
    let idx;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        lines.push(JSON.parse(line));
      } catch {}
    }
  }, 10);
  const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
  const wait = async (id, timeout = 6000) => {
    const t0 = Date.now();
    for (;;) {
      const f = lines.find((m) => m.id === id);
      if (f) return f;
      if (Date.now() - t0 > timeout) throw new Error(`等待 id=${id} 超时`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  return {
    child, send, wait,
    close: async () => {
      clearInterval(pump);
      child.kill();
      await new Promise((r) => {
        child.once('exit', r);
        setTimeout(r, 2000);
      });
    },
  };
}

test('安装包存在且含 sha256 记录', () => {
  assert.ok(existsSync(zip), `缺少 ${zip}（先运行 node scripts/build-package.mjs）`);
  assert.ok(existsSync(zip.replace(/\.zip$/, '.sha256')));
});

test('安装包独立启动：解压后直接运行 MCP 服务器', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'zcvi-pkg-'));
  try {
    extractZip(zip, tmp);
    assert.ok(existsSync(join(tmp, '.zcode-plugin', 'plugin.json')), '解压后清单存在');
    assert.ok(existsSync(join(tmp, 'server', 'server.mjs')), '解压后服务器存在');
    const rpc = spawnServer(tmp);
    try {
      rpc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
      const init = await rpc.wait(1);
      assert.equal(init.result.serverInfo.name, 'zcode-voice-input');
      rpc.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'voice_relay_info', arguments: {} } });
      const relay = await rpc.wait(2);
      assert.match(relay.result.structuredContent.url, /^ws:\/\/127\.0\.0\.1:\d+$/);
      rpc.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: 'ui://zcode-voice-input/panel.html' } });
      const read = await rpc.wait(3);
      assert.equal(read.result.contents[0].mimeType, 'text/html;profile=mcp-app');
    } finally {
      await rpc.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('marketplace.json 指向可安装的插件源目录', () => {
  const market = JSON.parse(readFileSync(join(root, 'market', 'marketplace.json'), 'utf8'));
  const entry = market.plugins.find((p) => p.name === 'zcode-voice-input');
  const resolved = join(root, 'market', entry.source);
  assert.ok(existsSync(join(resolved, '.zcode-plugin', 'plugin.json')));
});

test('安装/卸载脚本存在且语法有效', () => {
  for (const f of ['scripts/install-local.mjs', 'scripts/uninstall.mjs']) {
    const p = join(root, f);
    assert.ok(existsSync(p), f);
    // 语法检查
    execFileSync('node', ['--check', p]);
  }
});
