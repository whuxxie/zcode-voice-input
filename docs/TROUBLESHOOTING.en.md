# Troubleshooting

Locate by symptom. Universal three first steps: **① fully restart ZCode ② run `node scripts/doctor.mjs` ③ ask the Agent in-session to call `voice_status`.**

## Panel does not open / can't find the recording UI

| Symptom | Fix |
|---|---|
| See "Voice Input" next to the chat input but no recording appears | That's the **skill** (prompt template), not the panel. In the conversation, say **"open the voice input panel"（打开语音输入面板）** — the panel renders as a card inside the chat, with the mic button. |
| Want to open from Settings | Settings → Plugins → **click "ZCode Voice Input" to open the detail page** → **"Open"（打开）** (requires an open session in the current project). |
| Agent didn't call the tool when asked | Ask it to call the `voice_panel` tool explicitly; confirm the plugin is enabled and ZCode was restarted after install. |
| Install/update seems not applied | Fully quit (including tray) and relaunch ZCode. |
| Panel shows "MCP App failed" | Check `diagnostics` in `plugins list --json`; run `node scripts/doctor.mjs` to verify Node ≥ 22. |
| Plugin vanished from Settings | The market registration points to `dist/local-marketplace`, which was moved/deleted. Re-run `node scripts/install-local.mjs` from the repo. |

## Hotkey bar (overlay) issues

| Symptom | Fix |
|---|---|
| Installed the overlay, but no 🎤 next to the input after restart | Run `node scripts/install-overlay.mjs status` first. If it says "not installed" and ZCode was running during install: the background finalizer **waited 2 hours without a full quit**, timed out and deleted the staged package — rerun install, then **within 2 hours** fully quit ZCode (tray → Exit; closing the window is not enough) and reopen. |
| The bar disappeared after a ZCode auto-update | Official updates overwrite `app.asar` and drop the injection line. **The plugin itself, the panel, credentials and dictionary are unaffected** (the in-conversation panel keeps working). Rerun `node scripts/install-overlay.mjs` and fully restart ZCode to restore the bar. |
| The bar is there but F8 does nothing | Ask the Agent to call `voice_status` to confirm the plugin service/relay is up; allow microphone access in the system prompt on first use; the key is configurable under Settings → Plugins → Voice Input → Configure. |
| The transcript bubble covers chat text | Since v0.2.1 the bubble is a wide rectangle (280–600px) with a height cap; long transcripts scroll inside it and auto-stick to the latest text. You can still press Esc to cancel anytime. |

## Microphone

| Symptom | Fix |
|---|---|
| 🎤 says permission denied | Both grants must be allowed: the ZCode sandbox prompt **and** the OS permission. Windows: Settings → Privacy → Microphone. Ubuntu: Settings → Privacy/Sound, allow desktop apps to record (PipeWire sessions). |
| "Empty audio / silence" after stop | Wrong input device (switch in the picker next to ⚙); the mic is exclusively held by another app; or input level too low (record > 1 s, sit closer). |
| Ubuntu: no devices at all | Verify `pactl info` shows a default source; on Wayland ensure xdg-desktop-portal is running. |

## Can't find the credential configuration

| Symptom | Fix |
|---|---|
| Settings → Plugins only shows install/uninstall, no "Configure" | Configure is not on the list row. **Click the plugin name to open its detail page** → expand **"More details"（高级信息）** → the **Configure（配置）** block inside holds the credentials. |
| Detail page has no "More details"/"Configure" block | Plugin disabled, or ZCode not restarted after install. Enable the plugin and fully restart ZCode (the block renders from the plugin's declared userConfig and may be hidden while disabled). |
| Credentials saved but panel still shows Mock mode | "Save configuration" not clicked, or no restart/new session after saving. Save → fully quit and restart → the panel badge switches to real mode. |
| Secret field goes blank after clicking Save | **Normal**: sensitive fields are never echoed back (shoulder-surfing protection) — the value IS saved (reopening the config shows the "clear saved secret" button, which only appears when a value exists). Verify: after restarting ZCode the panel badge shows real mode, or ask the Agent to call `voice_status` → `credentialsConfigured: true`. |

## Recognition

| Symptom | Fix |
|---|---|
| Badge shows "Mock demo mode" | No credentials configured. Settings → Plugins → ZCode Voice Input → enter App Key (or App ID + Access Token), restart ZCode. |
| Real mode errors `E_ASR_45x` | Request-side: double-check credentials and that the resource ID matches what your console enabled (`volc.seedasr.sauc.duration` vs `...concurrent`). |
| Real mode `E_ASR_55000031/32` | Server busy/internal — retry shortly (flagged retryable). |
| `E_CONNECT_TIMEOUT` / `E_CONNECT` | `openspeech.bytedance.com:443` unreachable (proxy/firewall). Configure a system proxy for the ZCode process. |
| Tech terms transcribe oddly | Fix once in the textarea; persist via the dictionary — ask the Agent to call `voice_set_dictionary`, e.g. `{"word":"openGauss","match":["open高斯"]}`. Keep "Built-in hot words" on (default). |
| Duplicated transcript text | Should never happen (partials are cumulative). If seen, file an issue with the `voice_status` output. |

## Clipboard / paste

| Symptom | Fix |
|---|---|
| Copy fails | The panel auto-selects the text — press `Ctrl+C` manually. |
| Paste brings formatting | Paste as plain text: `Ctrl+Shift+V` (many apps/terminals on both OSes); in ZCode's own input plain `Ctrl+V` is fine. |

## Install / CLI

| Symptom | Fix |
|---|---|
| `install-local.mjs` can't find the CLI | Pass `--zcode <path>` or set `ZCODE_CLI`; on Linux look in `/usr/share/zcode/resources/glm/zcode.cjs`, `/opt/ZCode*/...`, or extract AppImages (`--appimage-extract`). Or use the GUI flow (README option B). |
| `plugin_variable_missing: ... user_config` | Fixed in current manifests (optional userConfig entries carry defaults). Update the repo and reinstall. |
| `Unsupported or missing plugin source` | The registered market is not the built `dist/local-marketplace`. Re-run `node scripts/build-package.mjs` and re-add the market. |
| Permission errors (Linux, system install) | The CLI writes user-level config under `~/.zcode/` — no root needed; if the CLI itself is unreadable, reinstall ZCode or use the GUI flow. |

## What to attach when filing an issue

```bash
node scripts/doctor.mjs
node "<zcode-install>/resources/glm/zcode.cjs" plugins list --json
```

Plus a screenshot of the ⚙ settings and the full error banner text (including the `[E_*]` code). **Never include any credentials.**
