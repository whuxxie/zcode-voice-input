// overlay-patch.test.mjs — asar 补丁库与 overlay 集成测试
'use strict';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ENTRY,
  INJECT_LINE_RE,
  injectLineFor,
  readHeader,
  iterFiles,
  readFileInAsar,
  repackAsar,
  computeIntegrity,
} from '../scripts/lib/asar-patch.mjs';
import { publishRuntime, syncOverlayFiles } from '../plugin/server/runtime-publisher.mjs';

// ---------- 测试用 asar 构造器（与真实格式一致：16B 元信息 + JSON 头 + 对齐 + 数据区） ----------
function buildAsar(dir, name, files, { withUnpacked = false } = {}) {
  const header = { files: {} };
  // 按真实 asar 的树形结构组织
  for (const [path, content] of files) {
    const parts = path.split('/');
    let node = header;
    for (let i = 0; i < parts.length - 1; i++) {
      node.files[parts[i]] = node.files[parts[i]] || { files: {} };
      node = node.files[parts[i]];
    }
    const leaf = parts[parts.length - 1];
    node.files[leaf] = { offset: '0', size: 0 }; // 占位，稍后填
  }
  // 依序分配 offset
  let offset = 0;
  const dataParts = [];
  for (const [path, content] of files) {
    const parts = path.split('/');
    let node = header;
    for (let i = 0; i < parts.length - 1; i++) node = node.files[parts[i]];
    const leaf = node.files[parts[parts.length - 1]];
    if (withUnpacked && path.endsWith('.unpacked.bin')) {
      leaf.unpacked = true;
      continue;
    }
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    leaf.offset = String(offset);
    leaf.size = buf.length;
    leaf.integrity = computeIntegrity(buf);
    dataParts.push(buf);
    offset += buf.length;
  }
  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const d = headerBytes.length;
  const c = Math.ceil((d + 4) / 4) * 4;
  const bTotal = c + 4;
  const out = Buffer.alloc(8 + bTotal + offset);
  out.writeUInt32LE(4, 0);
  out.writeUInt32LE(bTotal, 4);
  out.writeUInt32LE(c, 8);
  out.writeUInt32LE(d, 12);
  headerBytes.copy(out, 16);
  Buffer.concat(dataParts).copy(out, 8 + bTotal);
  const p = join(dir, name);
  writeFileSync(p, out);
  return p;
}

test('readHeader/readFileInAsar 能解析构造的 asar', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vi-asar-'));
  try {
    const p = buildAsar(dir, 'a.asar', [
      [ENTRY, 'console.log("main");\n'],
      ['assets/x.bin', Buffer.from([0, 1, 2, 255, 254, 0, 7])],
      ['nested/deep/y.txt', 'hello 世界'],
    ]);
    const { header, base } = readHeader(p);
    assert.ok(base > 16);
    assert.equal(iterFiles(header).length, 3);
    assert.equal(readFileInAsar(p, ENTRY).toString('utf8'), 'console.log("main");\n');
    assert.deepEqual([...readFileInAsar(p, 'assets/x.bin')], [0, 1, 2, 255, 254, 0, 7]);
    assert.equal(readFileInAsar(p, 'nested/deep/y.txt').toString('utf8'), 'hello 世界');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repackAsar 修改入口且其余文件逐字节不变', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vi-asar-'));
  try {
    const entry2 = Buffer.from('console.log("main patched");\n;import("file:///x");\n');
    const bin = Buffer.from(Array.from({ length: 100000 }, (_, i) => i & 0xff)); // 大文件走分块路径
    const p = buildAsar(dir, 'a.asar', [
      [ENTRY, 'console.log("main");\n'],
      ['big.bin', bin],
      ['k.txt', '尾部文件'],
    ]);
    const dst = join(dir, 'b.asar');
    await repackAsar(p, { [ENTRY]: entry2 }, dst);

    const before = readFileInAsar(p, ENTRY);
    const after = readFileInAsar(dst, ENTRY);
    assert.equal(after.toString('utf8'), entry2.toString('utf8'));
    assert.notEqual(after.length, before.length);

    // 未修改文件逐字节一致 + integrity 校验
    assert.deepEqual([...readFileInAsar(dst, 'big.bin')], [...bin]);
    assert.equal(readFileInAsar(dst, 'k.txt').toString('utf8'), '尾部文件');
    const { header } = readHeader(dst);
    const entryNode = iterFiles(header).find(([q]) => q === ENTRY)[1];
    assert.equal(entryNode.size, entry2.length);
    assert.equal(entryNode.integrity.hash, computeIntegrity(entry2).hash);
    // 文件总数不变
    assert.equal(iterFiles(header).length, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('repackAsar 保留 unpacked 文件标记', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'vi-asar-'));
  try {
    const p = buildAsar(dir, 'a.asar', [
      [ENTRY, 'x\n'],
      ['u.unpacked.bin', 'should-not-be-stored'],
      ['z.txt', 'z'],
    ], { withUnpacked: true });
    const dst = join(dir, 'b.asar');
    await repackAsar(p, { [ENTRY]: Buffer.from('x2\n') }, dst);
    const { header } = readHeader(dst);
    const node = iterFiles(header).find(([q]) => q === 'u.unpacked.bin')[1];
    assert.equal(node.unpacked, true);
    assert.equal(node.offset, '0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('注入行生成与幂等剥离', () => {
  const line = injectLineFor('file:///C:/u/.zcode/zcode-voice-input/inject-main.cjs');
  assert.ok(line.startsWith('\n;import("file:///C:/u/.zcode/zcode-voice-input/inject-main.cjs")'));
  assert.ok(line.includes('[voice-input] load failed'));

  const entry = 'ENTRY_CODE();\n' + line + '\nOTHER();\n' + injectLineFor('file:///D:/old/dir/zcode-voice-input/inject-main.cjs');
  const stripped = entry.replace(INJECT_LINE_RE, '');
  // 注入行自带前导换行，剥离后至多留下空行（对入口 JS 无影响）
  assert.equal(stripped.replace(/\n\n+/g, '\n'), 'ENTRY_CODE();\nOTHER();\n'); // 新旧目录的注入行都被剥离，他人代码不动
  assert.ok(!INJECT_LINE_RE.test(stripped));
});

// ---------- runtime publisher ----------
test('publishRuntime 写出完整配置且不含凭据字段', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vi-rt-'));
  try {
    const payload = publishRuntime(
      {
        version: '0.2.0-test',
        url: 'ws://127.0.0.1:56000',
        port: 56000,
        token: 'tok-abc',
        pttKey: 'F9',
        toggleKeys: 'Ctrl+Shift+K',
        useMock: true,
        settings: { enablePunc: true },
      },
      dir
    );
    assert.equal(payload.pttKey, 'F9');
    const saved = JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8'));
    assert.equal(saved.url, 'ws://127.0.0.1:56000');
    assert.equal(saved.token, 'tok-abc');
    assert.equal(saved.toggleKeys, 'Ctrl+Shift+K');
    // 不允许把凭据类字段写进 runtime.json
    for (const banned of ['apiKey', 'accessToken', 'appId']) {
      assert.ok(!(banned in saved), `${banned} 不应出现在 runtime.json`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('syncOverlayFiles 首次复制、内容一致时跳过', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vi-rt2-'));
  const fakePlugin = mkdtempSync(join(tmpdir(), 'vi-plug-'));
  try {
    mkdirSync(join(fakePlugin, 'overlay'), { recursive: true });
    writeFileSync(join(fakePlugin, 'overlay', 'overlay.js'), 'console.log(1);');
    writeFileSync(join(fakePlugin, 'overlay', 'inject-main.cjs'), 'console.log(2);');

    const copied1 = syncOverlayFiles(fakePlugin, dir);
    assert.deepEqual(copied1.sort(), ['inject-main.cjs', 'overlay.js']);
    const copied2 = syncOverlayFiles(fakePlugin, dir);
    assert.deepEqual(copied2, []); // 未变化不重写（保 mtime，利于热更新判断）

    writeFileSync(join(fakePlugin, 'overlay', 'overlay.js'), 'console.log(3);');
    const copied3 = syncOverlayFiles(fakePlugin, dir);
    assert.deepEqual(copied3, ['overlay.js']);
    assert.equal(readFileSync(join(dir, 'overlay.js'), 'utf8'), 'console.log(3);');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(fakePlugin, { recursive: true, force: true });
  }
});
