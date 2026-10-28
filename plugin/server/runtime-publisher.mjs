// runtime-publisher.mjs — 把中继连接信息与按键配置发布给 overlay 注入层
// 写 ~/.zcode/zcode-voice-input/runtime.json（主进程 loader 轮询此文件后推给窗口），
// 并把插件包内 overlay/ 两个文件同步到该目录（overlay.js mtime 变化触发 loader 热更新）。
// 说明：token 是环回中继的一次性随机鉴权值（24 字节），文件仅当前用户可读（默认权限），
// 与 apiKey 等凭据无关——凭据仍只在服务端进程内，绝不写入该目录。
'use strict';

import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function runtimeDir() {
  // ZCODE_VOICE_RUNTIME_DIR：测试与多实例隔离用；默认用户主目录下
  return process.env.ZCODE_VOICE_RUNTIME_DIR || join(homedir(), '.zcode', 'zcode-voice-input');
}

/**
 * 发布 runtime.json。
 * @param {{version:string,url:string,port:number,token:string,
 *          pttKey?:string,toggleKeys?:string,useMock?:boolean,
 *          settings?:object}} info
 */
export function publishRuntime(info, dir = runtimeDir()) {
  const payload = {
    version: info.version,
    url: info.url,
    port: info.port,
    token: info.token,
    pttKey: info.pttKey || 'F8',
    toggleKeys: info.toggleKeys || 'Ctrl+Shift+Space',
    useMock: !!info.useMock,
    settings: info.settings || {},
    updatedAt: Date.now(),
  };
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify(payload, null, 2), 'utf8');
  return payload;
}

/** 把插件包内 overlay 文件同步到 runtime 目录（内容一致则跳过，保留 mtime 便于热更新判断）。 */
export function syncOverlayFiles(pluginRoot, dir = runtimeDir()) {
  mkdirSync(dir, { recursive: true });
  const names = ['overlay.js', 'inject-main.cjs'];
  const copied = [];
  for (const name of names) {
    const src = join(pluginRoot, 'overlay', name);
    const dst = join(dir, name);
    if (!existsSync(src)) continue;
    let same = false;
    try {
      same = readFileSync(src, 'utf8') === readFileSync(dst, 'utf8');
    } catch {
      same = false;
    }
    if (!same) {
      copyFileSync(src, dst);
      copied.push(name);
    }
  }
  return copied;
}
