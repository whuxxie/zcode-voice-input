# Install Guide (Windows / Ubuntu)

This guide installs the **ZCode Voice Input** plugin into ZCode Desktop. The flow is identical on both platforms; only paths differ.

- [1. Prerequisites](#1-prerequisites)
- [2. Environment check](#2-environment-check)
- [3. Get the repo](#3-get-the-repo)
- [4. Option A: one-command install (CLI)](#4-option-a-one-command-install-cli)
- [5. Option B: GUI install (universal)](#5-option-b-gui-install-universal)
- [6. Configure Volcengine credentials](#6-configure-volcengine-credentials)
- [7. Verify the install](#7-verify-the-install)
- [8. Updating](#8-updating)
- [9. Uninstall](#9-uninstall)
- [10. Platform notes](#10-platform-notes)

## 1. Prerequisites

| Item | Requirement | Check |
|---|---|---|
| ZCode Desktop | any recent build (plugin system = MCP Apps) | you can open a session |
| Node.js | **≥ 22** (the plugin's MCP server uses the global WebSocket API) | `node --version` |
| OS | Windows 10/11 or Ubuntu 20.04+ (other Linux desktops similar) | — |
| Microphone | any working recording device | system settings |

Install Node.js ≥ 22 on Ubuntu (either way):

```bash
# nvm (recommended, no root needed)
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
source ~/.bashrc && nvm install 22 && nvm use 22

# or NodeSource (apt)
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

> Note: the plugin runtime itself has **zero npm dependencies**; Node is only used to run the plugin's MCP server process (ZCode launches it with the `node` command). Development/tests additionally need `npm install`.

## 2. Environment check

```bash
cd zcode-voice-input
node scripts/doctor.mjs
```

The doctor verifies: Node ≥ 22, whether the ZCode CLI can be located (common install paths on Windows/Linux plus the `ZCODE_CLI` env var), that the plugin manifest passes structural validation, and that the panel build is up to date. Any failure comes with a concrete suggestion.

## 3. Get the repo

```bash
git clone <repo-url> zcode-voice-input
cd zcode-voice-input
```

(or download the source archive from Releases.)

## 4. Option A: one-command install (CLI)

```bash
node scripts/install-local.mjs
```

The script: builds the panel → builds the local marketplace (`dist/local-marketplace`) → registers the market → installs and enables the plugin → prints the result.

- ZCode CLI discovery order: `--zcode <path>` argument → `ZCODE_CLI` env var → common locations
  (Windows: `C:\Program Files\ZCode`, `%LOCALAPPDATA%\Programs\ZCode`, other drives; Linux: `/usr/share/zcode`, `/opt/*`, `~/.local/share`, AppImage mount points).
- Explicit: `node scripts/install-local.mjs --zcode "/usr/share/zcode/resources/glm/zcode.cjs"`
- Add `--skip-build` to reuse an existing build.

Expected output:

```
Added marketplace dev-zcode-voice-input-local (1 plugins)
Installed plugin zcode-voice-input@dev-zcode-voice-input-local (0.1.0) [enabled]
Enabled plugin zcode-voice-input@dev-zcode-voice-input-local in .../config.json
```

## 5. Option B: GUI install (universal)

1. If you haven't built yet: `node scripts/build-package.mjs` (creates `dist/local-marketplace`).
2. Open ZCode → **Plugin Marketplace → Add → Add Plugin Marketplace**.
3. Paste the **absolute path** of this repo's `dist/local-marketplace` directory:
   - Windows e.g. `C:\path\to\zcode-voice-input\dist\local-marketplace`
   - Ubuntu e.g. `/home/<you>/zcode-voice-input/dist/local-marketplace`
4. Open the market **dev-zcode-voice-input-local** → plugin **ZCode Voice Input** → **Install** → **enable** if asked.
5. **Fully quit and restart ZCode** (quit from the tray, not just the window).

## 6. Configure Volcengine credentials

> **The configure block is nested in the plugin detail page's "More details" section** — it is not a button on the list row. Follow the exact path:

1. ZCode → **Settings** → **Plugins**.
2. In the **installed plugins list**, click **ZCode Voice Input** to open its **detail page**.
3. Expand **"More details"（高级信息）** on the detail page.
4. Inside, the **Configure（配置）** section is where credentials go — fill one of:
   - New speech console: **App Key** (sent as `X-Api-Key`)
   - Legacy console: **App ID** + **Access Token** (sensitive fields with a show-secret toggle and a clear-saved-secret button)
5. (Optional) Resource ID: default `volc.seedasr.sauc.duration` (Doubao streaming ASR 2.0, pay-per-duration); use `volc.seedasr.sauc.concurrent` for concurrent billing.
6. Click **Save configuration（保存配置）**, then **fully quit and restart ZCode** (or start a new session) so the env injection takes effect.

Can't find the Configure section? Check in order: the plugin is **enabled**; ZCode was **restarted after install**; you are on the plugin's **detail page** (the list row only has install/enable/uninstall — configure lives inside "More details" on the detail page).

Credentials are injected only into the plugin MCP server process environment — never written to the panel, logs, or this repo. Without credentials the plugin runs in clearly-labelled **Mock mode** (marked in the panel and via the `voice_status` tool).

## 7. Verify the install

```bash
node "<zcode-install>/resources/glm/zcode.cjs" plugins list --json
```

You should see `zcode-voice-input@dev-zcode-voice-input-local` with `"enabled": true`.

UI check: after restarting ZCode, open a new session → the **Voice Input** panel appears in the toolbar/plugin entry → click 🎤, allow microphone access on first use → speak → ⏹ Stop produces text.

## 7.5 (Recommended) Install the IME-style hotkey bar

Besides the in-conversation panel, v0.2.0 offers a pill pinned next to the chat input
(hold `F8` and speak; release inserts text straight into the input). It requires appending a
single injection line to the client's `app.asar` (same mechanism as `zcode-token-usage-statusbar`,
verified loadable on the same client):

```bash
node scripts/install-overlay.mjs           # install (idempotent)
node scripts/install-overlay.mjs status    # inspect injection state
node scripts/install-overlay.mjs uninstall # remove (strips only this plugin's line)
```

- If ZCode is **running**, the script stages a replacement package and spawns a background
  finalizer that completes the swap **once you fully quit ZCode** (tray → Exit); reopen afterwards.
  **The finalizer waits at most 2 hours** — past that it gives up and **deletes the staged
  package** (symptom: `status` reports "not installed"). Fully quit and reopen ZCode soon
  after installing; don't leave it staged.
- If the install dir is not writable, rerun the same command from an **elevated** terminal.
- Upgrading/reinstalling the plugin does **not** break the injection (the overlay runtime dir is
  independent of the plugin cache).
- An official ZCode upgrade overwrites `app.asar` and drops the injection: rerun install + restart.
- Prefer not to modify the client? Skip this step — the in-conversation panel is fully functional.

## 8. Updating

```bash
git pull
node scripts/install-local.mjs
```

Or via GUI: Plugin Marketplace → this market → refresh → update.

## 9. Uninstall

```bash
node scripts/uninstall.mjs               # remove the plugin
node scripts/uninstall.mjs --remove-market  # also unregister the market
```

Or GUI: Settings → Plugins → ZCode Voice Input → Uninstall.

## 10. Platform notes

| Item | Windows | Ubuntu |
|---|---|---|
| Install verification | ✅ tested locally (full install/enable/disable/uninstall/reinstall lifecycle) | ✅ CI runs the full suite on ubuntu-latest; the local install flow is the same (auto-discovery covers standard paths) |
| Mic capture | Chromium/WASAPI | Chromium/PipeWire-PulseAudio; the first run may need desktop permission in sound/privacy settings |
| Paste into input | Ctrl+V | Ctrl+V (consistent inside ZCode's own input on X11/Wayland) |
| zcode CLI location | `<drive>:\Program Files\ZCode\resources\glm\zcode.cjs` or `%LOCALAPPDATA%\Programs\ZCode\...` | `/usr/share/zcode/resources/glm/zcode.cjs`, `/opt/...`, inside AppImage (see doctor output) |
| Global hotkey | not implemented (no host API) | same |

Other limitations: [KNOWN_LIMITATIONS.md](../KNOWN_LIMITATIONS.md).
