// asar-patch.mjs — Electron asar 外科手术式补丁（零依赖，Node ≥18）
// 技术：asar = [16B 元信息][header JSON][对齐填充][文件数据区]。
// 只改一个文件（入口 out/main/index.js 尾部增删注入行），重算该文件 offset/size/integrity，
// 其余文件原样流式拷贝，不整包载入内存。与 zcode-token-usage-statusbar 的 patch_install.py
// 同构（该方案在本机 ZCode 上已实际验证可加载）。
'use strict';

import { openSync, readSync, closeSync, statSync, createReadStream, createWriteStream } from 'node:fs';
import { createHash } from 'node:crypto';

const ALIGN = 4;
const BLOCK = 4 * 1024 * 1024;
export const ENTRY = 'out/main/index.js';
export const MARKER = '[voice-input]';
// 匹配任何指向 zcode-voice-input 运行目录的历史注入行（迁移/重装时剥离）
export const INJECT_LINE_RE =
  /\n?;import\("[^"]*zcode-voice-input[^"]*inject-main\.cjs"\)\.then\(\(\) => null, \(e\) => console\.error\("\[voice-input\] load failed", e\)\);/g;

export function injectLineFor(loaderFileUrl) {
  return `\n;import("${loaderFileUrl}").then(() => null, (e) => console.error("${MARKER} load failed", e));`;
}

/** 读 asar 头。@returns {{header:object, base:number}} base=数据区起始偏移 */
export function readHeader(asarPath) {
  const fd = openSync(asarPath, 'r');
  try {
    const meta = Buffer.alloc(16);
    if (readSync(fd, meta, 0, 16, 0) !== 16) throw new Error('asar 太小，不是有效 asar');
    const a = meta.readUInt32LE(0);
    const b = meta.readUInt32LE(4);
    const c = meta.readUInt32LE(8);
    const d = meta.readUInt32LE(12);
    if (a !== 4) throw new Error(`意外的 asar 头前缀 ${a}`);
    if (d <= 0 || 8 + b <= 16) throw new Error('asar 头尺寸字段非法');
    const headerBuf = Buffer.alloc(d);
    if (readSync(fd, headerBuf, 0, d, 16) !== d) throw new Error('asar 头读取不完整');
    return { header: JSON.parse(headerBuf.toString('utf8')), base: 8 + b };
  } finally {
    closeSync(fd);
  }
}

/** 平铺 asar 内全部文件路径 → 节点（保持出现顺序）。@returns {Array<[string, object]>} */
export function iterFiles(header) {
  const out = [];
  (function walk(node, prefix) {
    const files = node && node.files;
    if (!files) return;
    for (const [name, child] of Object.entries(files)) {
      const p = prefix ? `${prefix}/${name}` : name;
      if (child && child.files) walk(child, p);
      else out.push([p, child]);
    }
  })(header, '');
  return out;
}

export function computeIntegrity(data) {
  const blocks = [];
  for (let i = 0; i < data.length; i += BLOCK) {
    blocks.push(createHash('sha256').update(data.subarray(i, i + BLOCK)).digest('hex'));
  }
  return {
    algorithm: 'SHA256',
    hash: createHash('sha256').update(data).digest('hex'),
    blockSize: BLOCK,
    blocks,
  };
}

function readRange(fd, start, length) {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, start + read);
    if (n <= 0) break;
    read += n;
  }
  return buf.subarray(0, read);
}

/** 读 asar 内单个文件内容 */
export function readFileInAsar(asarPath, entryPath) {
  const { header, base } = readHeader(asarPath);
  const node = iterFiles(header).find(([p]) => p === entryPath);
  if (!node) throw new Error(`asar 内不存在 ${entryPath}`);
  const fd = openSync(asarPath, 'r');
  try {
    return readRange(fd, base + Number(node[1].offset), node[1].size);
  } finally {
    closeSync(fd);
  }
}

/**
 * 重建 asar 到 dstPath。modify: {entryPath: Buffer}（替换内容，其余原样拷贝）。
 * 文件数据区按原格式背靠背拼接；仅 header 区域做 4 字节对齐填充。
 */
export async function repackAsar(srcPath, modify, dstPath) {
  const { header, base } = readHeader(srcPath);
  const nodes = iterFiles(header);
  const missing = Object.keys(modify).filter((p) => !nodes.some(([q]) => q === p));
  if (missing.length) throw new Error(`asar 内不存在: ${missing.join(', ')}`);

  // 第一遍：规划每个文件的新 size/offset（保持顺序；先记原始 offset 供拷贝用）
  let offset = 0;
  const plan = nodes.map(([p, node]) => {
    const srcOffset = Number(node.offset);
    if (node.unpacked) {
      node.offset = '0';
      return { path: p, node, unpacked: true, srcOffset };
    }
    const modified = Object.prototype.hasOwnProperty.call(modify, p);
    const size = modified ? modify[p].length : node.size;
    const item = { path: p, node, srcOffset, size, modified };
    node.offset = String(offset);
    node.size = size;
    if (modified) node.integrity = computeIntegrity(modify[p]);
    offset += size;
    return item;
  });

  const headerBytes = Buffer.from(JSON.stringify(header), 'utf8');
  const d = headerBytes.length;
  const c = Math.ceil((d + 4) / ALIGN) * ALIGN;
  const bTotal = c + 4;

  const out = createWriteStream(dstPath, { highWaterMark: BLOCK });
  const fail = (e) => {
    out.destroy();
    throw e;
  };
  try {
    const meta = Buffer.alloc(16);
    meta.writeUInt32LE(4, 0);
    meta.writeUInt32LE(bTotal, 4);
    meta.writeUInt32LE(c, 8);
    meta.writeUInt32LE(d, 12);
    if (!out.write(meta)) await new Promise((r) => out.once('drain', r));
    if (!out.write(headerBytes)) await new Promise((r) => out.once('drain', r));
    if (c - d - 4 > 0 && !out.write(Buffer.alloc(c - d - 4))) {
      await new Promise((r) => out.once('drain', r));
    }

    // 第二遍：流式写文件数据（未修改文件从源 asar 原始偏移拷贝）
    const srcFd = openSync(srcPath, 'r');
    try {
      const chunk = Buffer.alloc(BLOCK);
      for (const it of plan) {
        if (it.unpacked) continue;
        if (it.modified) {
          if (!out.write(modify[it.path])) await new Promise((r) => out.once('drain', r));
          continue;
        }
        let pos = base + it.srcOffset;
        const end = pos + it.size;
        while (pos < end) {
          const want = Math.min(BLOCK, end - pos);
          const buf = readRange(srcFd, pos, want);
          if (buf.length !== want) fail(new Error(`源数据读取不足: ${it.path}`));
          if (!out.write(buf)) await new Promise((r) => out.once('drain', r));
          pos += want;
        }
      }
    } finally {
      closeSync(srcFd);
    }
    await new Promise((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
  } catch (e) {
    try { out.destroy(); } catch {}
    throw e;
  }
  return statSync(dstPath).size;
}
