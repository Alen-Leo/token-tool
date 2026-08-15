# token-tool

[中文](./README.md) | **English**

A **lightweight, local-first** monitor for AI platform **subscription and usage** — Z.ai / GLM, DeepSeek, OpenCode Go, OpenRouter, SiliconFlow, Moonshot / Kimi, and more. Built as a tiny, zero-runtime-dependency Node server with a vanilla web UI.

Inspired by the open-source [Javis603/token-monitor](https://github.com/Javis603/token-monitor), but stripped down for the *cross-platform-relevant* part — querying provider APIs for subscription / balance / quota / model availability — without the weight of an Electron desktop shell.

> **Status:** The server + UI are platform-agnostic. They also ship as a **desktop app** — a menu-bar-resident app on macOS and a system-tray app on Windows / Linux — built with Electron. The exact same loopback server (security model intact) is embedded in-process by the Electron shell; the vanilla web UI is reused unchanged.

## Why this shape

| Goal | How |
|---|---|
| Lightweight | No npm runtime deps. Node built-ins only. UI is one HTML/CSS/JS file each, no build step. |
| Secure | Binds to `127.0.0.1` only · per-launch session token gates every API route · API keys stored in a `0600` file (`~/.token-tool/config.json`) · **strict outbound host allowlist** · keys masked everywhere they're surfaced · keys sent only to their owning provider. |
| Reliable | Graceful per-provider failure isolation, timeouts, allowlisted redirects. |
| Cross-platform ready | The provider/query layer is pure Node; the server runs unchanged on Windows/Linux; the static UI is the web build. |

## Providers (each surfaces *different* data)

| Provider | Auth | What you see |
|---|---|---|
| **Z.ai / GLM** | API key (`Bearer`) | Plan name + usage windows: 5-hour (session), Weekly, Monthly (MCP) — each with used %, token counts and reset time — plus the subscription renewal date and a one-line summary. |
| **DeepSeek** | API key (`Bearer`) + optional web login | Prepaid balance (with today & last-30-day spend) plus today's per-model token consumption (cache-hit / cache-miss input, output). |
| **OpenCode Go** | API key (`Bearer`) | Key liveness + count & list of models the plan unlocks; **local spend windows** when OpenCode is installed locally (session/weekly/monthly vs `$12/$30/$60` plan limits). |
| **OpenRouter** | API key (`Bearer`) | Account credits remaining (purchased / used / remaining, USD). |
| **SiliconFlow (硅基流动)** | API key (`Bearer`) | Account balance (total / paid-in / promotional, CNY). |
| **Moonshot / Kimi (月之暗面)** | API key (`Bearer`) | Account balance (available / cash / voucher, CNY), with China / international region switch. |

> Anthropic, OpenAI and others expose no public "query balance by API key" endpoint, so they are not wired up; their usage is only available via each vendor's admin API or web console.

## Quick start

```bash
cd token-tool
node src/server.js            # macOS / Linux also: ./scripts/run.sh
```

The launcher prints an authenticated URL and opens it in your default browser. The token in that URL is your session credential; it's moved into `sessionStorage` and stripped from the URL on load.

### Add keys (two ways)

- **UI** — click **⚙ Settings**, paste a key, **Test** (live probe, not saved), then **Save**.
- **File** — copy `config.example.json` to `~/.token-tool/config.json` (perms `0600`) and edit. Or use env vars:

```bash
export ZAI_API_KEY=...        # or GLM_API_KEY / ZHIPU_API_KEY
export DEEPSEEK_API_KEY=...
export OPENCODE_API_KEY=...
export OPENROUTER_API_KEY=...
export SILICONFLOW_API_KEY=...
export MOONSHOT_API_KEY=...   # or KIMI_API_KEY
node src/server.js
```

## Desktop app (macOS menu bar / Windows tray)

The same server + UI also run as a native-feeling desktop app. On macOS it lives
**only in the menu bar** (no Dock icon, `LSUIElement`); hover or left-click the
tray icon for a popover, click away to dismiss. On Windows / Linux it lives in
the **system tray**: the **first launch opens a real (framed) main window**,
hovering the tray icon shows the popover preview, left-click toggles the
popover, **double-click re-opens the main window**, and closing the main window
keeps the app running in the tray. Right-click the tray icon for **Open main
window** / Refresh / Open in browser / Quit.

The Electron shell embeds the loopback server **in-process** — the session
token, host allowlist, and `0600` key store are all unchanged. The renderer just
loads the authenticated loopback URL.

```bash
# Run from source (opens the desktop shell)
npm run electron

# Generate/regenerate the icon assets (pure-Node PNG encoder, zero deps)
npm run icons

# Package installers (artifacts land in dist/)
npm run electron:build:mac     # → Token-Tool-<v>-arm64.dmg / .zip  (arm64 + x64)
npm run electron:build:win     # → Token-Tool-Setup-<v>.exe (NSIS) + Portable .exe (x64)
```

> **macOS unsigned builds:** builds are not code-signed (no Apple Developer
> certificate). On first launch, right-click the app → **Open**, or
> `xattr -dr com.apple.quarantine "Token Tool.app"`. Signed/notarized builds
> need your own certificate wired into the `build.mac` config.
>
> **First `npm install` of Electron:** the Electron binary downloads from
> GitHub; if that's slow (notably in China), set a domestic mirror:
> ```bash
> export ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
> export ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
> ```

Verification helper while developing: launch with `TOKEN_TOOL_AUTO_SHOW=1` to
auto-reveal the popover on start (so it can be captured without a tray click):

```bash
TOKEN_TOOL_AUTO_SHOW=1 npm run electron
```

## Security model

- **Loopback only.** The server binds `127.0.0.1`; it is not reachable from the LAN.
- **Session token.** Generated per launch. Every `/api/*` route (except `/api/health`) requires it. The launcher hands it to the browser; the page stores it in `sessionStorage` and never writes it to disk.
- **Outbound allowlist.** Provider calls go to a fixed set of hosts (`api.z.ai`, `open.bigmodel.cn`, `api.deepseek.com`, `opencode.ai`, `openrouter.ai`, `api.siliconflow.cn`, `api.moonshot.cn`, `api.kimi.ai`). Any other destination is refused before a socket opens — this is the core defence against a tampered config exfiltrating keys.
- **Secret handling.** Keys live in `~/.token-tool/config.json` with `0600` perms (owner-only). They are masked in the UI and in any logs, and are only ever sent to their owning provider over HTTPS.
- **No telemetry.** The app sends nothing anywhere except the providers you configure.

## Layout

```
token-tool/
  src/
    server.js            loopback HTTP server, routing, auth; createServer()
    config.js            0600 config store + env override + masking
    security.js          session token + host allowlist + timing-safe compare
    providers/
      index.js           registry + parallel runner
      zai.js             Z.ai / GLM quota + subscription
      deepseek.js        DeepSeek balance + usage board (web token)
      opencode.js        OpenCode Go (local DB + key probe)
      openrouter.js      OpenRouter credits
      siliconflow.js     SiliconFlow balance
      moonshot.js        Moonshot / Kimi balance
    util/
      http.js            allowlisted, timeout-bound JSON getter
      format.js          shared window / money / token / time helpers
  web/                   static single-page UI (html/css/js)
  electron/
    main.js              Electron shell: tray + popover, embeds createServer()
  assets/                generated icons (app icon, mac tray template, win tray)
  scripts/
    run.sh               CLI launcher (macOS/Linux)
    gen-icons.mjs        pure-Node PNG icon generator (zero deps)
    postpack-info.mjs    lists build artifacts after a pack
  config.example.json    template (no secrets)
```

## Running tests

```bash
npm test     # node --test (discovers tests/*.test.js recursively)
```

## License

MIT. Provider endpoint behavior is documented from each provider's public API and from the reference project; this implementation is independent.
