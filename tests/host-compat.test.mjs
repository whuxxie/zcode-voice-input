// 测试 12：ZCode 宿主兼容性（对实测宿主实现的约束做自动化校验）
// 依据：ZCode 桌面端 app.asar 实测（MCP Apps / ext-apps）+ 官方 PLUGIN_DEVELOPMENT.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PLUGIN = join(root, 'plugin');

function spawnServer(env = {}) {
  const child = spawn('node', [join(PLUGIN, 'server', 'server.mjs')], {
    env: {
      ...process.env,
      ZCODE_PLUGIN_DATA: join(root, '.tmp-test-data'),
      // runtime.json/overlay 同步目录也重定向，避免测试污染真实 ~/.zcode
      ZCODE_VOICE_RUNTIME_DIR: join(root, '.tmp-test-runtime'),
      ...env,
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
  async function wait(id, timeout = 5000) {
    const t0 = Date.now();
    for (;;) {
      const found = lines.find((m) => m.id === id);
      if (found) return found;
      if (Date.now() - t0 > timeout) throw new Error(`等待响应 id=${id} 超时`);
      await new Promise((r) => setTimeout(r, 15));
    }
  }
  return {
    child, send, wait,
    async close() {
      clearInterval(pump);
      child.kill();
    },
  };
}

test('清单：name/version/ui.surfaces/mcpServers 符合宿主要求', () => {
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.zcode-plugin', 'plugin.json'), 'utf8'));
  assert.match(manifest.name, /^[a-z0-9][a-z0-9._-]{0,127}$/);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  const surface = manifest.ui.surfaces[0];
  assert.ok(surface.id.length >= 1);
  assert.equal(surface.server, Object.keys(manifest.mcpServers)[0], 'surface.server 必须指向已声明的 MCP 服务器');
  assert.match(surface.resourceUri, /^ui:\/\/[^/]+\/panel\.html$/);
  assert.equal(surface.availability, 'session');
  const server = manifest.mcpServers[surface.server];
  assert.equal(server.type, 'stdio');
  assert.ok(server.command, 'command 必填');
  assert.ok(server.args.some((a) => a.includes('${ZCODE_PLUGIN_ROOT}')), 'args 使用 ${ZCODE_PLUGIN_ROOT}');
  for (const [k, v] of Object.entries(server.env || {})) {
    assert.match(v, /^\$\{user_config\.[a-zA-Z0-9_]+\}$/, `env ${k} 必须来自 userConfig 注入`);
  }
  for (const key of ['appId', 'accessToken', 'apiKey']) {
    assert.equal(manifest.userConfig[key].sensitive, true, `${key} 必须 sensitive`);
  }
});

test('源码不含硬编码凭据', () => {
  const files = [
    join(PLUGIN, 'server', 'server.mjs'),
    join(PLUGIN, 'server', 'relay.js'),
    join(PLUGIN, 'server', 'volcano-asr.js'),
    join(PLUGIN, 'server', 'volcano-protocol.js'),
    join(PLUGIN, 'panel', 'src', 'panel.js'),
    join(PLUGIN, '.zcode-plugin', 'plugin.json'),
  ];
  // 高熵密钥特征：>=32 位、含数字、混合大小写或 base64 特征、无连字符（URL/slug 用连字符）
  const looksLikeSecret = (s) => {
    for (const m of s.matchAll(/[A-Za-z0-9+/_=]{32,}/g)) {
      const tok = m[0];
      if (tok.includes('-')) continue; // URL/slug
      if (!/\d/.test(tok)) continue; // 纯字母单词（可能性低）
      if (!/[A-Z]/.test(tok) && !/[a-z]/.test(tok)) continue; // 纯数字（常量ID）
      if (/^[A-Fa-f0-9]{32,}$/.test(tok)) continue; // 十六进制哈希常量可另行审查
      return tok;
    }
    return null;
  };
  for (const f of files) {
    assert.ok(existsSync(f), f);
    const s = readFileSync(f, 'utf8');
    const hit = looksLikeSecret(s);
    assert.equal(hit, null, `${f} 疑似硬编码高熵凭据: ${hit && hit.slice(0, 12)}...`);
    assert.ok(!/AKLT[A-Za-z0-9]{10,}|LTAI[A-Za-z0-9]{10,}/.test(s), `${f} 疑似云 AK`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(s), `${f} 疑似私钥`);
  }
});

test('面板资源：mimeType profile=mcp-app、_meta 含 csp/permissions、大小 < 8MB（宿主资源上限）', async () => {
  const rpc = spawnServer();
  try {
    rpc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } });
    await rpc.wait(1);
    rpc.send({ jsonrpc: '2.0', id: 2, method: 'resources/list' });
    const list = await rpc.wait(2);
    assert.equal(list.result.resources.length, 1);
    const res = list.result.resources[0];
    assert.equal(res.mimeType, 'text/html;profile=mcp-app');
    assert.ok(res._meta, 'resources/list 必须携带 _meta（宿主从这里读 csp/permissions）');
    assert.ok(res._meta.ui.csp.connectDomains[0].match(/^ws:\/\/127\.0\.0\.1:\d+$/), 'connectDomains 为环回 ws origin');
    assert.ok(res._meta.ui.permissions.microphone !== undefined, '声明 microphone 权限');
    assert.ok(res._meta.ui.permissions.clipboardWrite !== undefined, '声明 clipboardWrite 权限');
    rpc.send({ jsonrpc: '2.0', id: 3, method: 'resources/read', params: { uri: res.uri } });
    const read = await rpc.wait(3);
    const c = read.result.contents[0];
    assert.equal(c.mimeType, 'text/html;profile=mcp-app');
    assert.ok(c.text.length > 100000, '面板为自包含构建产物');
    assert.ok(Buffer.byteLength(c.text, 'utf8') < 8 * 1024 * 1024, '宿主限制 resources/read 8MB');
    assert.ok(!/\ssrc\s*=\s*["'](?!data:|blob:|#)/.test(c.text.slice(c.text.indexOf('<body'))), 'body 内不得有相对/外链脚本');
    assert.ok(c.text.includes('getUserMedia'), '面板包含麦克风采集');
    assert.ok(!/X-Api-Access-Key|accessToken.*=.*['"][A-Za-z0-9]/.test(c.text), '面板不含凭据');
  } finally {
    await rpc.close();
  }
});

test('协议兼容：未知方法返回 -32601，ping 返回空结果', async () => {
  const rpc = spawnServer();
  try {
    rpc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await rpc.wait(1);
    rpc.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const pong = await rpc.wait(2);
    assert.deepEqual(pong.result, {});
    rpc.send({ jsonrpc: '2.0', id: 3, method: 'no/such/method' });
    const err = await rpc.wait(3);
    assert.equal(err.error.code, -32601);
  } finally {
    await rpc.close();
  }
});

test('工具清单：面板专属工具 visibility=[app]，状态工具对模型可见', async () => {
  const rpc = spawnServer();
  try {
    rpc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await rpc.wait(1);
    rpc.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    const r = await rpc.wait(2);
    const byName = Object.fromEntries(r.result.tools.map((t) => [t.name, t]));
    assert.equal(byName.voice_relay_info._meta.ui.visibility.join(','), 'app');
    assert.equal(byName.voice_status._meta.ui.visibility.join(','), 'model,app');
    // voice_panel：模型可调用且绑定面板资源（宿主在对话内渲染面板的官方机制）
    assert.equal(byName.voice_panel._meta.ui.visibility.join(','), 'model,app');
    assert.equal(byName.voice_panel._meta.ui.resourceUri, 'ui://zcode-voice-input/panel.html');
    assert.equal(byName.voice_panel._meta.ui.surface, 'voice-input');
  } finally {
    await rpc.close();
  }
});

test('voice_status 不泄露凭据值', async () => {
  const rpc = spawnServer({ ZCODE_VOICE_API_KEY: 'super-secret-key-value-123456', ZCODE_VOICE_APP_ID: 'appid-123' });
  try {
    rpc.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await rpc.wait(1);
    rpc.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'voice_status', arguments: {} } });
    const r = await rpc.wait(2);
    const sc = r.result.structuredContent;
    assert.equal(sc.credentialsConfigured, true);
    assert.equal(sc.backendMode, 'real');
    assert.ok(!JSON.stringify(sc).includes('super-secret-key-value-123456'), '不得包含密钥值');
    assert.ok(!JSON.stringify(sc).includes('appid-123'), '不得包含 appId 值');
  } finally {
    await rpc.close();
  }
});

test('marketplace.json 条目与清单一致', () => {
  const market = JSON.parse(readFileSync(join(root, 'market', 'marketplace.json'), 'utf8'));
  assert.ok(market.name.startsWith('dev-'), '开发市场名以 dev- 前缀');
  const entry = market.plugins.find((p) => p.name === 'zcode-voice-input');
  assert.ok(entry, '包含本插件');
  const manifest = JSON.parse(readFileSync(join(PLUGIN, '.zcode-plugin', 'plugin.json'), 'utf8'));
  assert.equal(entry.version, manifest.version);
  assert.ok(existsSync(join(root, 'market', entry.source)), `source 相对路径存在: ${entry.source}`);
});

test('面板构建产物为最新（与源码一致）', () => {
  const { execFileSync } = require('node:child_process');
  const before = readFileSync(join(PLUGIN, 'panel', 'panel.html'), 'utf8');
  execFileSync('node', [join(root, 'scripts', 'build-panel.mjs')], { cwd: root });
  const after = readFileSync(join(PLUGIN, 'panel', 'panel.html'), 'utf8');
  assert.equal(before, after, 'panel.html 可由源码确定性重建');
});

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
