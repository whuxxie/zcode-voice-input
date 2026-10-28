# ZCode Voice Input

[English](./README.md) | [简体中文](./README.zh-CN.md) | [安装指南 / Install](#installation) | [使用说明 / Usage](#usage) | [故障排查 / Troubleshooting](docs/TROUBLESHOOTING.en.md)

Voice input for the **ZCode Desktop** app: click the microphone, dictate your coding request, watch the live transcription, edit the text, then paste it into the Agent input box (or use the host confirmation dialog). Powered by **Volcengine Doubao Streaming ASR 2.0** (豆包流式语音识别大模型 2.0, `volc.seedasr.sauc.duration`).

> **The plugin never auto-sends anything.** The final Enter keypress is always yours.

Verified on **Windows**; the plugin is fully cross-platform (Node.js + web standard APIs) and tested on **Ubuntu Linux** in CI. See [Installation](#installation) for both platforms.

---

## Features

- 🎤 One-click recording from a ZCode side panel (MCP Apps UI, sandboxed by the host)
- ⏺ Two modes: **sentence streaming** (default, live partial results + definite sentences) and **one-shot** (single final result after stop)
- ✍️ Editable result box — review and correct text before it goes anywhere
- 📋 Copy to clipboard / paste guidance / optional host-confirmed submit (`ui/message`, ZCode shows an editable confirmation dialog)
- 🈶 Chinese / English / mixed input with official hot-word support (`corpus.context`), built-in programmer glossary (Spring Boot, MyBatis, openGauss, PostgreSQL, Vue, Java, JavaScript, TypeScript, MQTT, GNSS, Cesium, Docker, Git, GitHub, API, JSON, SQL, WebSocket) and a personal dictionary
- ⚙️ Conservative post-processing (all off by default): final punctuation, stutter cleanup, whole-word tech-term casing — never rewrites code identifiers, paths, ports, or SQL
- 🔒 Secrets stay in the plugin's MCP server process (injected via plugin `userConfig`), never in the panel, logs, or repo; the local relay listens on `127.0.0.1` with a per-boot token
- 🖥️ Microphone device picker, duration display, error surfacing with retryable flags, full resource cleanup, concurrency guard

## How it works

```
ZCode Desktop (Electron)
 ├─ Chat input (Lexical editor) — no draft-write API exists; user pastes/confirms
 └─ Plugin sandbox webview (zcode-sandbox://plugin-*)
     └─ panel.html (mic capture via AudioWorklet → 16 kHz s16le PCM; contains no secrets)
         │  ws://127.0.0.1:<port>  (one-time token, origin-checked; loopback ws is
         ▼                         explicitly allowed by the host CSP normalizer)
     Plugin MCP server (Node stdio process — the only place credentials exist)
     ├─ Local loopback ASR relay (minimal RFC6455 server, ephemeral port)
     ├─ Backend factory: real Volcengine / Mock (offline demo & tests)
     └─ Term processing (official hot words + conservative post-processing)
```

## Installation

Prerequisites: **ZCode Desktop** and **Node.js ≥ 22** on your `PATH` (needed for the plugin's MCP server; check with `node --version`).

Run the environment check first:

```bash
node scripts/doctor.mjs
```

### Windows

```powershell
# from the repo root
node scripts/install-local.mjs
```

This builds the panel, creates the local marketplace at `dist/local-marketplace`, registers it and installs/enables the plugin via the bundled ZCode CLI (`<ZCode install>/resources/glm/zcode.cjs`, auto-discovered; override with `--zcode <path>` or the `ZCODE_CLI` env var).

### Ubuntu Linux

```bash
# Node.js 22+ is required (e.g. via nvm: nvm install 22)
node scripts/doctor.mjs          # verifies node, finds the zcode CLI, validates the manifest
node scripts/install-local.mjs   # same flow as Windows; CLI auto-discovery covers
                                 # /usr/share/zcode, /opt/*, ~/.local/share, AppImage dirs
```

If the CLI cannot be found, use the **GUI flow (identical on both OSes)**:

1. ZCode → **Plugin Marketplace → Add → Add Plugin Marketplace** → paste the absolute path of `dist/local-marketplace`.
2. Open that market → **ZCode Voice Input** → **Install** → enable it.
3. Restart ZCode completely, then open a new session.

Full step-by-step guides: [安装指南（中文）](docs/INSTALL.zh-CN.md) · [Install guide (English)](docs/INSTALL.en.md)

### Configure credentials

Exact location (the configure block lives inside the plugin detail's "advanced" section):

1. ZCode → **Settings** → **Plugins**.
2. In the installed list, click **ZCode Voice Input** to open its detail page.
3. Expand **"More details"（高级信息）**.
4. The **Configure（配置）** block inside is where credentials go (choose one):
   - **App Key** (new speech console, sent as `X-Api-Key`), or
   - **App ID + Access Token** (legacy console, sent as `X-Api-App-Key` / `X-Api-Access-Key`)
5. Click **Save configuration（保存配置）**, then **fully quit and restart ZCode** (or start a new session).

Resource ID defaults to `volc.seedasr.sauc.duration` (Doubao streaming ASR 2.0, pay-per-duration). Without credentials the plugin runs in clearly-labelled **Mock mode** (demo text, no network calls to Volcengine).

> Don't see the Configure block? Make sure the plugin is enabled and ZCode was restarted after install. The block appears because the plugin declares `userConfig`, nested under the detail page's "More details" expander (sensitive fields have show-secret / clear-secret buttons).

## Usage

Two forms (same engine, same secrets handling):

### 1. IME-style hotkey bar (recommended, v0.2.0+)

A tiny 🎤 pill sits **pinned next to the chat input box** — it never scrolls away with the conversation:

- **Hold `F8`** (PTT) and speak; release to insert the transcript **at the caret in the chat input**, IME-style.
- Or press **`Ctrl+Shift+Space`** to start, press again to finish; `Esc` cancels; clicking the pill toggles too.
- Hotkeys are configurable in the plugin config page (`pttKey` / `toggleKeys`); changes apply after a full ZCode restart.

This form requires a one-time overlay install (it patches the client's `app.asar` by appending a single import line — same technique as `zcode-token-usage-statusbar`; `uninstall` removes it cleanly):

```bash
node scripts/install-overlay.mjs           # install (idempotent; auto-finalizes after ZCode exits)
node scripts/install-overlay.mjs status    # check state
node scripts/install-overlay.mjs uninstall # remove the injection line
```

Then fully quit (tray → Exit) and restart ZCode.

### 2. In-conversation panel (no patch needed, fallback)

1. In a conversation, ask the Agent to **"open the voice input panel"**（打开语音输入面板）
   (or: Settings → Plugins → the plugin's detail page → "Open") — the recording panel with the
   mic button renders inside the conversation / side pane.
2. 🎤 Start recording (allow microphone access on first use) → speak → ⏹ Stop.
3. Review/edit the transcript. Live preview shows in-progress text while recording.
4. 📥 **Copy & prepare paste** → click the ZCode chat input → `Ctrl+V` → press Enter yourself.

Details: [使用说明（中文）](docs/USAGE.zh-CN.md) · [Usage (English)](docs/USAGE.en.md) · Problems: [Troubleshooting](docs/TROUBLESHOOTING.en.md)

## Development

```bash
npm install                     # dev/test deps only (ws); the plugin runtime is zero-dependency
npm test                        # 67 tests: protocol, client, relay, terms, audio, state machine,
                                # host-compat conformance, packaging, lifecycle
node scripts/build-panel.mjs    # rebuild the self-contained panel.html
node scripts/build-package.mjs  # rebuild dist/local-marketplace + distributable zip (+sha256)
node scripts/uninstall.mjs      # uninstall (--remove-market also drops the market)
```

CI runs the full test suite on `ubuntu-latest` and `windows-latest` (Node 22/24) — [`.github/workflows/ci.yml`](.github/workflows/ci.yml).

Project bookkeeping: [PROGRESS.md](PROGRESS.md) · [TASK_QUEUE.md](TASK_QUEUE.md) · [TEST_RESULTS.md](TEST_RESULTS.md) · [INSTALL_STATUS.md](INSTALL_STATUS.md) · [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)

## Privacy & security

- Audio is sent only to Volcengine's ASR endpoint via the loopback relay; credentials never leave the MCP server process.
- The relay binds `127.0.0.1` on an ephemeral port and requires a per-boot random token; non-loopback peers are rejected.
- The sandbox cannot read the clipboard (host-enforced); the panel only writes it.
- Nothing is auto-sent to the Agent; the optional "submit" path requires explicit user confirmation in ZCode's own dialog.

## License

MIT — see [LICENSE](LICENSE). Bundled third-party: `@modelcontextprotocol/ext-apps` (MIT).
