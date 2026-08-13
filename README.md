# Codex Board

Codex Board is an unofficial, open-source board and chat client for local Codex tasks. The repository contains a Windows desktop app built with Tauri and React, plus an Expo/React Native mobile client that connects privately to the desktop through Tailscale.

> Codex Board is an independent project and is not affiliated with or endorsed by OpenAI.

## Features

- Dynamic columns from every task-title prefix before the first exact ` - ` separator (`WIP - …`, `To Plan - …`, or any custom prefix).
- Custom empty categories, renaming and drag-to-reorder with no fixed category list.
- Dragging cards between columns renames the real Codex task and verifies that Codex persisted the title.
- Internal chat with persisted history, streamed responses, Markdown, collapsible technical activity and turn interruption.
- New Codex tasks can be created from desktop or mobile, with project, category, title and first message.
- Backend-owned FIFO follow-up queue shared by desktop and mobile and persisted across restarts.
- Automatic or manual command, file-change and permission approvals.
- Working indicators on cards and a persistent in-app Inbox for completions, errors and approval requests.
- Shared backend persistence for categories, order and approval mode.
- Authenticated HTTP/WebSocket access inside the encrypted private Tailscale network.
- Expo mobile client with QR pairing, encrypted credential storage, live board/chat, approvals, questions, card moves and category management.
- Persistent automations for intervals, one-time runs, weekly calendars and timed category pipelines, manageable from desktop or mobile.
- An illustrated first-run product tour, always available again from Help.
- Crash-safe JSON persistence with last-known-good backups and automatic recovery for board state, queues, automations and Inbox.

## How categories work

Codex Board does not impose standard workflow names. Every non-empty prefix is a category:

```text
WIP - Implement pairing        → WIP
Waiting - Review dependency    → Waiting
Anything Else - Write tests    → Anything Else
Task without a separator       → Uncategorized
```

Categories and their order belong to Codex Board and are persisted by the Rust backend. They remain visible when empty and are shared with connected mobile clients. Renaming a populated category updates all affected Codex task titles as a verified transaction; completed renames are rolled back if a later rename fails.

## Set up remote mobile access

The Rust gateway listens only on `127.0.0.1:47821`; it is never exposed directly to the public Internet. Tailscale is installed separately on the PC and phone.

### One-time setup

1. Open Tailscale on Windows and sign in.
2. Install Tailscale from the Play Store or App Store on the phone and sign in with the same account.
3. Download the APK from the latest [GitHub release](https://github.com/federicopf/codex-board/releases/latest), open it on Android and install it. Android may ask once for permission to install apps from the browser.
4. Start the newly installed **Codex Board** app on the phone.

The release APK is built automatically by GitHub Actions. You do not need an Expo account, Expo Go, Metro or a USB connection.

### Pair the phone

1. Keep Tailscale connected on both devices.
2. Open Codex Board on Windows and select **Remote**.
3. Select **Enable remote access**. Codex Board creates a tailnet-only HTTP proxy on port `47822` to its loopback gateway on port `47821`.
4. A private pairing QR appears. In the mobile app select **Scan pairing QR** and scan it.
5. After the first pairing, the credential remains encrypted on the phone; normal use only requires Tailscale and Codex Board to be running.

Tailscale encrypts traffic end-to-end between the devices. The internal HTTP endpoint is reachable only inside the tailnet, does not require public TLS certificates, and every request additionally requires the random 256-bit credential contained in the QR. The Expo client stores that credential with `expo-secure-store` in the iOS Keychain or Android Keystore-backed encrypted storage.

The PC may be on any network and the phone may use another Wi-Fi or mobile data. The PC must be powered on, connected to Tailscale and running Codex Board. No router port forwarding, public tunnel or ngrok session is required.

## Automations

Open **Automations** on desktop or the lightning button on mobile. A task can run once at a precise date and time, repeat every N minutes, or follow a weekly calendar with selected days and a local time. It uses the normal message queue if the task is already working. A pipeline rule watches every task in its source category and moves it to the destination after it has remained there for the configured number of minutes. Rules and category entry times are stored on the PC, survive restarts, and run while Codex Board is open.

## Product guide

The illustrated guide opens automatically the first time Codex Board runs. It explains the board, the integrated chat, remote access and automations without requiring prior Codex knowledge. Reopen it at any time with **?** on desktop or **Categories → Product tour** on mobile.

## Requirements

### Desktop

- Windows 10 or 11 x64
- Node.js 22.13 or newer (required by Expo SDK 57)
- Rust stable with the `x86_64-pc-windows-msvc` host
- Visual Studio 2022 Build Tools with **Desktop development with C++**
- Microsoft Edge WebView2 Runtime
- Codex for Windows, or a standalone Codex CLI available as `codex` in `PATH`

Codex Board automatically discovers the local runtime installed by Codex for Windows. Override discovery with the `CODEX_EXECUTABLE` environment variable.

### Mobile

- The Codex Board APK from GitHub Releases, or Expo Go for development
- Android 7+ or iOS 16.4+
- Tailscale signed into the same tailnet as the PC

## Monorepo

```text
src/                       Desktop React UI
src-tauri/                 Tauri app, Codex client and private remote gateway
apps/mobile/               Expo SDK 57 / React Native client
packages/protocol/         Shared remote protocol types and pairing parser
scripts/                   Codex app-server verification tools
```

The desktop frontend still invokes local Tauri commands. The Rust core owns the single `codex app-server` child process, shared board configuration and authenticated remote API. Mobile uses authenticated tailnet HTTP for commands and WebSocket for live Codex and board events. The official Codex protocol is never exposed directly.

## Development

Install all workspaces from the repository root:

```powershell
npm install
```

Desktop:

```powershell
npm test
cargo test --manifest-path .\src-tauri\Cargo.toml
npm run tauri dev
```

Mobile:

```powershell
npm run mobile:typecheck
npm run mobile
```

Then scan the Expo development QR with Expo Go. This Metro QR launches the app; it is separate from the Codex Board pairing QR shown by the desktop app.

Generate Codex protocol schemas after a CLI upgrade:

```powershell
codex app-server generate-json-schema --out .\src-tauri\schemas\codex-<version>
```

Run the real protocol smoke test without changing an existing title:

```powershell
node .\scripts\verify-app-server.mjs
```

## Build

Windows installer:

```powershell
npm run tauri build
```

Expo Android bundle verification:

```powershell
cd .\apps\mobile
npx expo export --platform android
```

Build an installable Android APK with EAS as an optional alternative:

```powershell
npx eas-cli login
npm run mobile:apk
```

The `preview` profile in `apps/mobile/eas.json` creates an APK for direct installation. A distributable iOS build additionally requires an Apple developer account and iOS signing through EAS.

Pushing a version tag such as `v0.2.0` runs `.github/workflows/android-apk.yml`, builds a standalone signed APK and attaches it to the corresponding GitHub release.

## Security notes

- The gateway binds to loopback only and requires a bearer credential on every HTTP and WebSocket request.
- Remote routes expose only explicit board and Codex operations; they do not expose arbitrary shell or app-server stdio access.
- Treat pairing QR codes as secrets.
- `npm audit` currently reports advisories inherited through Expo/Metro build tooling. The suggested automatic remediation downgrades Expo across major SDK versions, so it is intentionally not applied; update when Expo publishes a compatible dependency chain.

See [PLAN.md](./PLAN.md) for the original MVP scope.

## License

MIT. See [LICENSE](./LICENSE).
