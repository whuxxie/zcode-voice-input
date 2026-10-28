// relay.js — 本地回环 ASR 中继（最小 RFC6455 WebSocket 服务端）
// 安全设计：
//  - 仅监听 127.0.0.1（随机端口），拒绝任何非环回连接
//  - 每次服务器启动生成随机 token，面板必须在 hello 中携带正确 token，否则断开
//  - 密钥永不通过此通道下发；面板与中继之间无凭据
//  - 限制并发 ASR 会话数，防止本机其他进程滥用
'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { gzipSync } = require('./volcano-protocol.js');

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

/** 极简 WebSocket 服务端帧编解码（面向浏览器客户端：客户端帧带掩码） */
class WsConn {
  constructor(socket) {
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.onmessage = null; // (opcode:1|2, payload:Buffer)
    this.onclose = null;
    this.closed = false;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed());
    socket.on('error', () => this._closed());
    socket.setNoDelay(true);
  }
  // 上一行 "_ onData" 故意写成方法名 _onData；修正：
  _onData(d) {
    if (this.closed) return;
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : Buffer.from(d);
    for (;;) {
      const f = this._readFrame();
      if (!f) break;
      const { opcode, payload } = f;
      if (opcode === 0x8) {
        this.close(1000);
        this._closed();
        return;
      } else if (opcode === 0x9) {
        this._sendFrame(0xa, payload); // ping -> pong
      } else if (opcode === 0xa) {
        // pong 忽略
      } else if (opcode === 0x1 || opcode === 0x2) {
        if (this.onmessage) this.onmessage(opcode, payload);
      }
    }
  }
  _readFrame() {
    const b = this.buf;
    if (b.length < 2) return null;
    const fin = b[0] & 0x80;
    const opcode = b[0] & 0x0f;
    const masked = b[1] & 0x80;
    let len = b[1] & 0x7f;
    let o = 2;
    if (len === 126) {
      if (b.length < o + 2) return null;
      len = b.readUInt16BE(o);
      o += 2;
    } else if (len === 127) {
      if (b.length < o + 8) return null;
      const big = b.readBigUInt64BE(o);
      if (big > 32n * 1024n * 1024n) {
        this.close(1009);
        return null;
      }
      len = Number(big);
      o += 8;
    }
    let mask = null;
    if (masked) {
      if (b.length < o + 4) return null;
      mask = b.slice(o, o + 4);
      o += 4;
    }
    if (b.length < o + len) return null;
    let payload = b.slice(o, o + len);
    if (mask) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
    }
    this.buf = b.slice(o + len);
    if (!fin) {
      // 不支持跨帧分片（浏览器小帧不会分片）；把分片按当前帧处理并告警
      // 简化处理：当作独立帧
    }
    return { opcode, payload };
  }
  _sendFrame(opcode, payload) {
    if (this.closed) return;
    const len = payload.length;
    let header;
    if (len < 126) {
      header = Buffer.from([0x80 | opcode, len]);
    } else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(len), 2);
    }
    this.socket.write(header);
    if (len) this.socket.write(payload);
  }
  sendText(s) {
    this._sendFrame(0x1, Buffer.from(s, 'utf8'));
  }
  sendBinary(b) {
    this._sendFrame(0x2, b);
  }
  close(code = 1000) {
    if (this.closed) return;
    try {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(code, 0);
      this._sendFrame(0x8, b);
    } catch {}
    try {
      this.socket.end();
    } catch {}
  }
  _closed() {
    if (this.closed) return;
    this.closed = true;
    if (this.onclose) this.onclose();
  }
}

/**
 * 创建中继服务器。
 * @param options.backendFactory async (sessionParams, events) => backend
 *   backend: {sendAudio(pcm), stop():Promise<{text}>, cancel(), onPartial(fn)}
 *   sessionParams: {mode, sampleRate, settings, dictionary}
 *   events: {partial(payload), final({text}), error(err)}
 * @returns {server, port, token, close()}
 */
function createRelay(options = {}) {
  const {
    backendFactory,
    maxSessions = 2,
    logger = { info() {}, warn() {}, error() {} },
    maxAudioChunkBytes = 256 * 1024,
  } = options;
  if (!backendFactory) throw new TypeError('backendFactory required');

  const token = crypto.randomBytes(24).toString('base64url');
  let active = 0;
  const conns = new Set();

  const server = http.createServer((_req, res) => {
    // 非升级请求一律拒绝（防探测）
    res.writeHead(426, { Connection: 'close' });
    res.end('WebSocket required');
  });

  server.on('upgrade', (req, socket) => {
    try {
      const host = String(req.headers.host || '');
      const hostname = host.split(':')[0];
      if (hostname !== '127.0.0.1' && hostname !== 'localhost') {
        socket.destroy();
        return;
      }
      // 认证边界是 hello.token（24 字节随机数）+ 仅环回监听；调用方源不固定
      // （MCP 沙箱面板 origin 为 zcode-sandbox://，主窗口注入的 overlay 录音条 origin
      // 为应用自身），因此不再按 Origin 拒绝，未持 token 的连接在 hello 阶段即被断开
      const key = req.headers['sec-websocket-key'];
      if (!key) {
        socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
        socket.destroy();
        return;
      }
      // RFC 6455 规定握手使用 SHA-1 计算 Sec-WebSocket-Accept（协议固定值，非安全用途，无法更换算法）
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\n' +
          'Upgrade: websocket\r\n' +
          'Connection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${accept}\r\n` +
          '\r\n'
      );
      const conn = new WsConn(socket);
      conns.add(conn);
      let session = null;
      let helloDone = false;

      const send = (obj) => conn.sendText(JSON.stringify(obj));

      conn.onclose = () => {
        conns.delete(conn);
        if (session) {
          try {
            session.cancel();
          } catch {}
          active--;
          session = null;
        }
      };

      conn.onmessage = (opcode, payload) => {
        if (opcode === 0x1) {
          let msg;
          try {
            msg = JSON.parse(payload.toString('utf8'));
          } catch {
            send({ type: 'error', code: 'E_BAD_MSG', message: '非法 JSON 控制消息' });
            return;
          }
          if (!helloDone) {
            if (msg.type !== 'hello' || msg.token !== token) {
              send({ type: 'error', code: 'E_AUTH', message: 'token 无效' });
              conn.close(1008);
              return;
            }
            if (active >= maxSessions) {
              send({ type: 'error', code: 'E_BUSY', message: `已有 ${maxSessions} 个录音会话进行中` });
              conn.close(1013);
              return;
            }
            helloDone = true;
            active++;
            const sessionParams = {
              mode: msg.mode === 'nostream' ? 'nostream' : 'sentence',
              sampleRate: clampInt(msg.sampleRate, 8000, 48000, 16000),
              settings: sanitizeSettings(msg.settings),
              dictionary: sanitizeDictionary(msg.dictionary),
              // mockScript 仅为 Mock 后端的演示/测试钩子，真实火山后端不读取
              ...(Array.isArray(msg.mockScript) ? { mockScript: msg.mockScript.slice(0, 20).map((s) => String(s).slice(0, 50)) } : {}),
            };
            const events = {
              partial: (p) => send({ type: 'partial', ...p }),
              final: (p) => {
                send({ type: 'final', ...p });
                active--;
                session = null;
              },
              error: (e) => {
                send({ type: 'error', code: e.code || 'E_ASR', message: e.message, retryable: !!e.retryable });
                // 中途失败即释放会话（幂等：session 已置空则跳过，避免重复计数）
                if (session) {
                  try {
                    session.cancel();
                  } catch {}
                  session = null;
                  active--;
                }
              },
            };
            Promise.resolve()
              .then(() => backendFactory(sessionParams, events))
              .then((backend) => {
                if (conn.closed) {
                  try {
                    backend.cancel();
                  } catch {}
                  return;
                }
                session = backend;
                send({
                  type: 'ready',
                  mode: sessionParams.mode,
                  sampleRate: sessionParams.sampleRate,
                });
              })
              .catch((e) => {
                events.error(e instanceof Error ? { code: e.code || 'E_BACKEND', message: e.message } : e);
                conn.close(1011);
                active--;
              });
            return;
          }
          if (msg.type === 'stop') {
            if (session) {
              session
                .stop()
                .then((r) => {
                  send({ type: 'final', text: r.text, durationMs: r.durationMs });
                  active--;
                  session = null;
                })
                .catch((e) => {
                  send({ type: 'error', code: e.code || 'E_ASR', message: e.message, retryable: !!e.retryable });
                  active--;
                  session = null;
                });
            } else {
              send({ type: 'error', code: 'E_NO_SESSION', message: '当前没有进行中的识别会话' });
            }
            return;
          }
          if (msg.type === 'cancel') {
            if (session) {
              try {
                session.cancel();
              } catch {}
              active--;
              session = null;
            }
            send({ type: 'cancelled' });
            return;
          }
          if (msg.type === 'ping') {
            send({ type: 'pong', t: Date.now() });
            return;
          }
        } else if (opcode === 0x2) {
          // 音频二进制
          if (!helloDone) {
            send({ type: 'error', code: 'E_AUTH', message: '必须先发送 hello' });
            conn.close(1008);
            return;
          }
          if (!session) {
            send({ type: 'error', code: 'E_NO_SESSION', message: '识别会话未就绪' });
            return;
          }
          if (payload.length > maxAudioChunkBytes) {
            send({ type: 'error', code: 'E_AUDIO_TOO_LARGE', message: '音频分片过大' });
            return;
          }
          try {
            session.sendAudio(payload);
          } catch (e) {
            send({ type: 'error', code: 'E_SEND_AUDIO', message: e.message });
          }
        }
      };
    } catch (e) {
      try {
        socket.destroy();
      } catch {}
      logger.error('[relay] upgrade 处理失败:', e.message);
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        port,
        token,
        url: `ws://127.0.0.1:${port}`,
        close() {
          for (const c of conns) c.close(1001);
          server.close();
        },
      });
    });
  });
}

function clampInt(v, min, max, dflt) {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function sanitizeSettings(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    enablePunc: o.enablePunc !== false,
    enableItn: o.enableItn !== false,
    enableDdc: o.enableDdc === true,
    addPunctuation: o.addPunctuation === true,
    cleanRepeat: o.cleanRepeat === true,
    applyCaseFix: o.applyCaseFix === true,
    includeBuiltinTerms: o.includeBuiltinTerms !== false,
  };
}

function sanitizeDictionary(d) {
  if (!Array.isArray(d)) return [];
  return d
    .slice(0, 200)
    .map((e) => {
      if (typeof e === 'string') return { word: e.slice(0, 30) };
      if (e && typeof e.word === 'string') {
        const out = { word: e.word.slice(0, 30) };
        if (Array.isArray(e.match)) out.match = e.match.slice(0, 10).map((m) => String(m).slice(0, 30));
        return out;
      }
      return null;
    })
    .filter(Boolean);
}

module.exports = { createRelay, WsConn };
