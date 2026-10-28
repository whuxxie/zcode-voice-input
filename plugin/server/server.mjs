#!/usr/bin/env node
// server.mjs — ZCode Voice Input 插件 MCP 服务器（stdio, JSON-RPC 2.0, 零依赖）
// 职责：
//   1. 实现 MCP 协议最小子集：initialize / ping / tools/* / resources/*
//   2. 启动本地回环 ASR 中继（ws://127.0.0.1:<ephemeral>，token 鉴权）
//   3. 提供 UI 面板资源 ui://zcode-voice-input/panel.html
//      _meta.ui: csp.connectDomains=[ws://127.0.0.1:port], permissions={microphone, clipboardWrite}
//   4. 凭据管理：仅从环境变量读取（userConfig.sensitive 注入），绝不下发到面板、绝不写日志
'use strict';

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRelay } from './relay.js';
import { createBackendFactory } from './backend-factory.mjs';
import { DEFAULT_ENDPOINT, RESOURCE_ID_20_DURATION } from './volcano-asr.js';
import { redactSecrets } from './term-processor.js';
import { publishRuntime, syncOverlayFiles } from './runtime-publisher.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(__dirname, '..');
// 版本号唯一来源：plugin.json（避免多处硬编码漂移）
const VERSION = JSON.parse(readFileSync(join(PLUGIN_ROOT, '.zcode-plugin', 'plugin.json'), 'utf8')).version;
const SERVER_NAME = 'zcode-voice-input';
const PANEL_URI = `ui://${SERVER_NAME}/panel.html`;
const SURFACE_ID = 'voice-input';

// ---------- 配置（环境变量；sensitive 值不落盘、不日志） ----------
function readCredentials() {
  const appId = process.env.ZCODE_VOICE_APP_ID || '';
  const accessToken = process.env.ZCODE_VOICE_ACCESS_TOKEN || '';
  const apiKey = process.env.ZCODE_VOICE_API_KEY || '';
  const hasLegacy = !!(appId && accessToken);
  const hasNew = !!apiKey;
  return { appId, accessToken, apiKey, hasLegacy, hasNew, hasAny: hasLegacy || hasNew };
}

function readConfig() {
  return {
    endpoint: process.env.ZCODE_VOICE_ENDPOINT || DEFAULT_ENDPOINT,
    resourceId: process.env.ZCODE_VOICE_RESOURCE_ID || RESOURCE_ID_20_DURATION,
    model: process.env.ZCODE_VOICE_MODEL || '2.0',
    billing: process.env.ZCODE_VOICE_BILLING || 'duration',
    useMock: process.env.ZCODE_VOICE_USE_MOCK === '1' || !readCredentials().hasAny,
  };
}

// ---------- 持久化（词典/设置） ----------
const dataDir =
  (process.env.ZCODE_PLUGIN_DATA && String(process.env.ZCODE_PLUGIN_DATA)) ||
  join(process.env.HOME || process.env.USERPROFILE || '.', '.zcode', 'voice-input-data');
try {
  mkdirSync(dataDir, { recursive: true });
} catch {}

function readJsonSafe(file, dflt) {
  const p = join(dataDir, file);
  try {
    if (!existsSync(p)) return dflt;
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return dflt;
  }
}
function writeJsonSafe(file, obj) {
  try {
    writeFileSync(join(dataDir, file), JSON.stringify(obj, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}
const getDictionary = () => readJsonSafe('dictionary.json', []);
const getSettings = () =>
  readJsonSafe('settings.json', {
    addPunctuation: false,
    cleanRepeat: false,
    applyCaseFix: false,
    includeBuiltinTerms: true,
    enablePunc: true,
    enableItn: true,
    enableDdc: false,
  });

// ---------- 中继 ----------
const logger = {
  info: (...a) => safeLog('info', a),
  warn: (...a) => safeLog('warning', a),
  error: (...a) => safeLog('error', a),
};
function safeLog(level, args) {
  // 一切日志脱敏后走 MCP logging 通知（stderr 会污染 stdio 传输，禁止使用）
  const text = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  try {
    send({ jsonrpc: '2.0', method: 'notifications/message', params: { level, data: redactSecrets(text) } });
  } catch {}
}

const backendFactory = createBackendFactory({
  logger,
  getConfig: readConfig,
  getCredentials: readCredentials,
});

const relayPromise = createRelay({ backendFactory, logger });
let relay = null;
relayPromise.then((r) => {
  relay = r;
  logger.info(`本地 ASR 中继已启动 ws://127.0.0.1:${r.port}`);
  try {
    // 供主窗口 overlay 录音条连接（注入层经 runtime.json 获取端口/token/按键）
    publishRuntime({
      version: VERSION,
      url: r.url,
      port: r.port,
      token: r.token,
      pttKey: process.env.ZCODE_VOICE_PTT_KEY || 'F8',
      toggleKeys: process.env.ZCODE_VOICE_TOGGLE_KEYS || 'Ctrl+Shift+Space',
      useMock: readConfig().useMock,
      settings: getSettings(),
    });
    const copied = syncOverlayFiles(PLUGIN_ROOT);
    if (copied.length) logger.info(`overlay 文件已同步: ${copied.join(', ')}`);
  } catch (e) {
    logger.warn(`runtime.json 发布失败: ${e.message}`);
  }
});

// ---------- MCP JSON-RPC ----------
const PROTOCOL_VERSION = '2025-06-18';
let clientCapabilities = {};

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}
function result(id, r) {
  send({ jsonrpc: '2.0', id, result: r });
}
function errorReply(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  {
    name: 'voice_panel',
    description:
      '打开语音输入面板：在当前对话中渲染带麦克风按钮的录音界面（开始/停止/取消、实时预览、可编辑结果、复制/粘贴指引）。当用户想用语音向 Agent 口述需求、要求"打开语音输入/麦克风/录音面板"时调用本工具。面板不会自动发送任何消息。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    visibility: ['model', 'app'],
    ui: { resourceUri: PANEL_URI, surface: SURFACE_ID },
  },
  {
    name: 'voice_relay_info',
    description:
      '获取本地语音识别中继连接信息（仅面板使用）。返回 ws://127.0.0.1 URL、一次性 token 与使用说明。不含任何云端凭据。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    visibility: ['app'],
  },
  {
    name: 'voice_status',
    description:
      '查询语音输入插件状态：凭据是否已配置（只返回布尔值，不含密钥）、ASR 后端模式（真实/Mock）、中继端口、词典条数、当前设置。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    visibility: ['model', 'app'],
  },
  {
    name: 'voice_get_dictionary',
    description: '获取用户自定义术语词典（用于识别热词与可选的保守后处理）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    visibility: ['model', 'app'],
  },
  {
    name: 'voice_set_dictionary',
    description: '设置用户自定义术语词典。每条为 {word: "标准写法", match: ["识别中可能出现的变体"]}。',
    inputSchema: {
      type: 'object',
      properties: {
        terms: {
          type: 'array',
          maxItems: 200,
          items: {
            type: 'object',
            properties: { word: { type: 'string' }, match: { type: 'array', items: { type: 'string' } } },
            required: ['word'],
          },
        },
      },
      required: ['terms'],
    },
    visibility: ['app'],
  },
  {
    name: 'voice_get_settings',
    description: '获取语音输入后处理设置（补标点/清理口头重复/整词规范写法/内置术语热词开关/云端标点与顺滑开关）。',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    visibility: ['model', 'app'],
  },
  {
    name: 'voice_set_settings',
    description: '设置语音输入后处理选项。默认全部保守（false）——保留原始识别结果，不自动改语义。',
    inputSchema: {
      type: 'object',
      properties: {
        addPunctuation: { type: 'boolean' },
        cleanRepeat: { type: 'boolean' },
        applyCaseFix: { type: 'boolean' },
        includeBuiltinTerms: { type: 'boolean' },
        enablePunc: { type: 'boolean' },
        enableItn: { type: 'boolean' },
        enableDdc: { type: 'boolean' },
      },
      additionalProperties: false,
    },
    visibility: ['app'],
  },
];

function toolDefs() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    _meta: { ui: { visibility: t.visibility, ...(t.ui || {}) } },
  }));
}

async function callTool(name, args) {
  switch (name) {
    case 'voice_panel': {
      if (!relay) relay = await relayPromise;
      return {
        panelOpened: true,
        panelUri: PANEL_URI,
        instructions:
          '面板已在本对话中渲染：点击麦克风图标开始录音，停止后查看/编辑文字，再复制粘贴到输入框。不会自动发送。',
      };
    }
    case 'voice_relay_info': {
      if (!relay) {
        relay = await relayPromise;
      }
      return {
        url: relay.url,
        port: relay.port,
        token: relay.token,
        panelHints: {
          audio: 'PCM s16le 单声道 16kHz，二进制帧，建议 100~200ms/片',
          control: '文本帧 JSON: hello{token,mode,sampleRate,settings,dictionary} / stop / cancel',
          events: 'ready/partial/final/error/cancelled',
        },
      };
    }
    case 'voice_status': {
      const cfg = readConfig();
      const cred = readCredentials();
      if (!relay) relay = await relayPromise;
      return {
        version: VERSION,
        credentialsConfigured: cred.hasAny,
        credentialStyle: cred.hasNew ? 'apiKey(新版控制台)' : cred.hasLegacy ? 'appId+accessToken(旧版控制台)' : 'none',
        backendMode: cfg.useMock ? 'mock' : 'real',
        model: cfg.model,
        resourceId: cfg.resourceId,
        endpoint: cfg.endpoint,
        relayPort: relay.port,
        dictionaryCount: getDictionary().length,
        settings: getSettings(),
        note: cfg.useMock
          ? '当前为 Mock 模式：识别结果是演示数据。请在插件设置中配置火山引擎凭据后重启会话。'
          : '已配置凭据，将连接真实火山引擎服务。',
      };
    }
    case 'voice_get_dictionary':
      return { terms: getDictionary(), builtinCount: 'see docs' };
    case 'voice_set_dictionary': {
      const terms = Array.isArray(args?.terms) ? args.terms : null;
      if (!terms) throw Object.assign(new Error('terms 必须为数组'), { code: 'E_ARGS' });
      const clean = terms
        .filter((t) => t && typeof t.word === 'string' && t.word.trim())
        .slice(0, 200)
        .map((t) => ({ word: t.word.trim().slice(0, 30), ...(Array.isArray(t.match) ? { match: t.match.slice(0, 10).map((m) => String(m).slice(0, 30)) } : {}) }));
      writeJsonSafe('dictionary.json', clean);
      return { ok: true, count: clean.length };
    }
    case 'voice_get_settings':
      return getSettings();
    case 'voice_set_settings': {
      const cur = getSettings();
      const allowed = ['addPunctuation', 'cleanRepeat', 'applyCaseFix', 'includeBuiltinTerms', 'enablePunc', 'enableItn', 'enableDdc'];
      for (const k of allowed) {
        if (typeof args?.[k] === 'boolean') cur[k] = args[k];
      }
      writeJsonSafe('settings.json', cur);
      return { ok: true, settings: cur };
    }
    default:
      throw Object.assign(new Error(`未知工具: ${name}`), { code: 'E_UNKNOWN_TOOL' });
  }
}

function resourceMeta() {
  if (!relay) return null; // 在 relay 未就绪时先返回 null，resources/read 前会 await
  return {
    ui: {
      csp: { connectDomains: [`ws://127.0.0.1:${relay.port}`] },
      permissions: { microphone: {}, clipboardWrite: {} },
      prefersBorder: false,
    },
  };
}

async function readPanelResource() {
  if (!relay) relay = await relayPromise;
  const htmlPath = join(PLUGIN_ROOT, 'panel', 'panel.html');
  const html = readFileSync(htmlPath, 'utf8');
  const meta = resourceMeta();
  const content = { uri: PANEL_URI, mimeType: 'text/html;profile=mcp-app', text: html };
  if (meta) content._meta = meta;
  return { contents: [content], ...(meta ? { _meta: meta } : {}) };
}

const list = () => [
  {
    uri: PANEL_URI,
    name: 'panel',
    title: { 'zh-CN': '语音输入', 'en-US': 'Voice Input' },
    description: '语音输入面板：录音、实时识别、编辑、复制/确认插入。',
    mimeType: 'text/html;profile=mcp-app',
    ...(resourceMeta() ? { _meta: resourceMeta() } : {}),
  },
];

// ---------- stdio 主循环 ----------
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    handleMessage(line).catch((e) => {
      logger.error('处理消息失败:', e && e.message);
    });
  }
});
process.stdin.on('end', () => {
  if (relay) relay.close();
  process.exit(0);
});

async function handleMessage(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;
  try {
    switch (method) {
      case 'initialize':
        clientCapabilities = params?.capabilities || {};
        result(id, {
          protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false }, logging: {} },
          serverInfo: { name: SERVER_NAME, version: VERSION },
          instructions:
            'ZCode Voice Input：点击面板中的麦克风开始录音，识别文本可在面板中编辑，通过"复制"或"确认插入"交给用户自行粘贴/发送。不会自动发送任何消息。',
        });
        break;
      case 'notifications/initialized':
        break;
      case 'ping':
        result(id, {});
        break;
      case 'tools/list':
        result(id, { tools: toolDefs() });
        break;
      case 'tools/call': {
        const name = params?.name;
        try {
          const r = await callTool(name, params?.arguments || {});
          result(id, {
            content: [{ type: 'text', text: JSON.stringify(r) }],
            structuredContent: r,
          });
        } catch (e) {
          result(id, {
            content: [{ type: 'text', text: `错误: ${e.message}` }],
            isError: true,
          });
        }
        break;
      }
      case 'resources/list':
        result(id, { resources: list() });
        break;
      case 'resources/read': {
        const uri = params?.uri;
        if (uri !== PANEL_URI) {
          errorReply(id, -32602, `未知资源: ${uri}`);
          break;
        }
        result(id, await readPanelResource());
        break;
      }
      case 'resources/templates/list':
        result(id, { resourceTemplates: [] });
        break;
      case 'logging/setLevel':
        result(id, {});
        break;
      default:
        if (!isNotification) {
          errorReply(id, -32601, `方法不存在: ${method}`);
        }
    }
  } catch (e) {
    if (!isNotification) errorReply(id, -32603, `内部错误: ${e.message}`);
  }
}

logger.info(`[voice-input] MCP 服务器启动 v${VERSION} dataDir=${dataDir}`);
