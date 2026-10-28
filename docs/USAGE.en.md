# Usage Guide

- [0. IME-style hotkey bar (v0.2.0, recommended)](#0-ime-style-hotkey-bar-v020-recommended)
- [1. Opening the panel](#1-opening-the-panel)
- [2. A full voice-input round](#2-a-full-voice-input-round)
- [3. Panel controls](#3-panel-controls)
- [4. Getting text into the Agent input](#4-getting-text-into-the-agent-input)
- [5. Speaking tips](#5-speaking-tips)
- [6. Glossary & post-processing settings](#6-glossary--post-processing-settings)
- [7. Mock vs real mode](#7-mock-vs-real-mode)
- [8. Agent helper tools](#8-agent-helper-tools)
- [9. Behavior boundaries (important)](#9-behavior-boundaries-important)

## 0. IME-style hotkey bar (v0.2.0, recommended)

After installing the overlay (see the [install guide](INSTALL.en.md)), a small 🎤 pill sits pinned
next to the chat input and **never scrolls away**. Three equivalent interactions:

| Action | Effect |
| --- | --- |
| **Hold `F8` (PTT)** | Press to record; release to insert the transcript **at the caret** in the chat input |
| **`Ctrl+Shift+Space`** | Press once to start, again to finish and insert; `Esc` cancels |
| **Click the 🎤 pill** | Same as the combo — click to toggle start/finish |

- A bubble shows the live transcript while recording (a wide, height-capped rectangle — long
  transcripts scroll inside it and stick to the latest words), then the inserted text for ~2s.
- If no chat composer is visible (e.g. a fullscreen dialog), the pill hides itself and returns automatically.
- Rebinding keys: Settings → Plugins → Voice Input → Configure → `pttKey` / `toggleKeys`;
  fully restart ZCode after saving.
- Recordings cap at 60 s (auto-finish); taps shorter than 0.25 s are ignored.
- Removing the bar: `node scripts/install-overlay.mjs uninstall`, then fully restart ZCode.

## 1. Opening the panel

**Note**: the "Voice Input" item next to the chat input (composer picker) is the **skill** (a prompt template), not the recording UI. Open the actual panel either way:

**Way A (recommended, most direct)** — just ask the Agent in the conversation:

> Open the voice input panel / I want to dictate / 打开语音输入面板

The Agent calls the `voice_panel` tool and **the recording panel (with the mic button) renders right inside the conversation**.

**Way B (manual)**: Settings → Plugins → **click "ZCode Voice Input" to open its detail page** → the **"Open"（打开）** button
(requires an open session in the current project; the panel opens as a side pane/tab you can pin).

First recording asks for two grants: the ZCode sandbox prompt and the system microphone permission.

## 2. A full voice-input round

```
🎤 Start → speak (live preview) → ⏹ Stop → review/edit
→ 📥 Copy & prepare paste → click chat input → Ctrl+V → review → press Enter
```

- The first 🎤 click triggers two grants: the ZCode sandbox permission prompt and the system/browser microphone permission. Allow both.
- While recording: pulsing red dot, running timer, live preview (in-progress text may change — normal).
- After stop: the final text lands in the **editable** box, ready for corrections.

## 3. Panel controls

| Control | Purpose |
|---|---|
| 🎤 Start | Starts recording + ASR session; guarded against double-click concurrency |
| ⏹ Stop | Ends recording, waits for the final transcript |
| ✖ Cancel | Discards the take and releases resources immediately |
| Timer / status dot | Duration and state (idle/starting/recording/processing/done/error) |
| Live preview | In-progress partial transcript while recording |
| Result textarea | Final text — directly editable |
| 📋 Copy text | Writes to the system clipboard |
| 📥 Copy & prepare paste | Copy + paste guidance (recommended path) |
| ✈️ Submit to conversation | Hands the text to ZCode's confirmation dialog (shown when the host supports it) |
| 🔁 Retry / Clear | Start a new take; clear the result |
| ⚙ Settings | Post-processing switches (section 6) |
| Mic picker | Device selection once granted; restart recording after switching |

## 4. Getting text into the Agent input

In recommended order:

1. **📥 Copy & prepare paste (default, most reliable)**: click the chat input → `Ctrl+V` → review → press Enter yourself. The panel shows guidance for this.
2. **✈️ Submit to conversation (optional)**: ZCode shows an **editable confirmation dialog** pre-filled with the transcript — edit there if needed; it only sends after you confirm.
3. **📋 Copy text**: plain copy for pasting anywhere else.

> The plugin has **no auto-send path whatsoever**; ZCode itself offers no draft-write API for the chat input (a host capability boundary, not a plugin limitation).

## 5. Speaking tips

- 20–40 cm from the mic, natural pace; cloud punctuation is on by default.
- **Paths, ports, identifiers, filenames**: speak them naturally ("/" as "slash", "." as "dot"); the transcript keeps them verbatim — still glance over the text before sending.
- Mixed Chinese/English works out of the box ("用 Spring Boot 连接 openGauss").
- For long dictation, pause every 1–2 minutes (stop → review → paste) to keep proofreading easy.
- If a technical spelling comes out wrong, fix it once in the textarea; add it to the dictionary (section 6) for a lasting fix.

## 6. Glossary & post-processing settings

Panel ⚙ Settings (saved instantly, applied to the next recording):

| Switch | Default | Effect |
|---|---|---|
| Final punctuation | off | Appends a period if the transcript ends without one |
| Clean stutters | off | Collapses adjacent repeats ("那个那个"→"那个"); short words only |
| Tech-term casing | off | Whole-word replacement per dictionary (`springboot` → `Spring Boot`); never touches identifiers/args |
| Built-in hot words | **on** | Injects 18 built-in tech terms into Volcengine hot words |

Personal dictionary: the Agent can manage it via `voice_set_dictionary`; entries look like
`{"word": "openGauss", "match": ["open高斯", "opengauss"]}` — `word` is the canonical display form, `match` lists variants you actually pronounce (used for hot words and optional whole-word replacement).

> Design rule: every post-processor is off by default; hot words are applied by the ASR engine itself (safest); whole-word replacement only runs when explicitly enabled and only on exact whole-word matches. No unsolicited rewriting.

## 7. Mock vs real mode

The badge in the panel header shows the current backend:

- **Real mode**: credentials configured; connects to Volcengine Doubao Streaming ASR 2.0.
- **Mock demo mode** (yellow badge): no credentials. The full pipeline works but the transcript is **demo data** and nothing reaches Volcengine. Great for UI trials and onboarding.

Switch via **Settings → Plugins → click "Voice Input" to open the detail page → expand "More details" → "Configure"**, add or clear credentials, click **Save configuration**, then restart ZCode or start a new session.

## 8. Agent helper tools

Ask the Agent in-session (handy for support and personalization):

- `voice_status` — mode, whether credentials are configured (booleans only, no secret values), dictionary size, settings.
- `voice_get_settings` / `voice_set_settings` — the section-6 switches.
- `voice_get_dictionary` / `voice_set_dictionary` — personal dictionary.

Example prompt: "Set my voice-input dictionary so 'cesium' transcribes as Cesium and 'open高斯' as openGauss."

## 9. Behavior boundaries (important)

- Nothing is auto-sent by default; "submit" always goes through ZCode's own confirmation dialog.
- The plugin never reads the clipboard (host-enforced); it only writes.
- Credentials never appear in the panel, logs, or this repo; the local relay binds 127.0.0.1 with a per-boot token.
- Audio is sent only to the Volcengine ASR endpoint for transcription.

See [TROUBLESHOOTING.en.md](TROUBLESHOOTING.en.md) for problems.
