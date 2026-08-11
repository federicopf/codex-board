# Codex Board

Codex Board is an unofficial, open-source board and chat client for local Codex tasks. The repository contains a Windows desktop app built with Tauri and React, plus an Expo/React Native mobile client that connects privately to the desktop through Tailscale.

> Codex Board is an independent project and is not affiliated with or endorsed by OpenAI.

## Features

- Dynamic columns from every task-title prefix before the first exact ` - ` separator (`WIP - …`, `To Plan - …`, or any custom prefix).
- Custom empty categories, renaming and drag-to-reorder with no fixed category list.
- Dragging cards between columns renames the real Codex task and verifies that Codex persisted the title.
- Internal chat with persisted history, streamed responses, Markdown, collapsible technical activity and turn interruption.
- FIFO follow-up message queue while Codex is working.
- Automatic or manual command, file-change and permission approvals.
- Working indicators on cards and completion notifications.
- Shared backend persistence for categories, order and approval mode.
- Authenticated HTTPS/WebSocket access over a private Tailscale network.
- Expo mobile client with QR pairing, encrypted credential storage, live board status and chat.

## How categories work

Codex Board does not impose standard workflow names. Every non-empty prefix is a category:

```text
WIP - Implement pairing        → WIP
Waiting - Review dependency    → Waiting
Anything Else - Write tests    → Anything Else
Task without a separator       → Uncategorized
```

Categories and their order belong to Codex Board and are persisted by the Rust backend. They remain visible when empty and are shared with connected mobile clients. Renaming a populated category updates all affected Codex task titles as a verified transaction; completed renames are rolled back if a later rename fails.

## Remote mobile access

The Rust gateway listens only on `127.0.0.1:47821`; it is never exposed directly to the public Internet. From the desktop app:

1. Install and sign in to [Tailscale](https://tailscale.com/download/windows) on the PC and phone.
2. Select **Remote** in Codex Board.
3. Select **Enable remote access**. Codex Board runs `tailscale serve --bg localhost:47821`.
4. Scan the displayed QR code from Codex Board Mobile.

Tailscale Serve provides the private HTTPS address and TLS certificate. The QR contains that address and a random 256-bit device credential. The Expo client stores the credential with `expo-secure-store` in the iOS Keychain or Android Keystore-backed encrypted storage.

The PC must be powered on, connected to Tailscale and running Codex Board. No router port forwarding, public tunnel or ngrok session is required.

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

- Expo Go for development, or a development/release build
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

The desktop frontend still invokes local Tauri commands. The Rust core owns the single `codex app-server` child process, shared board configuration and authenticated remote API. Mobile uses HTTPS for commands and WebSocket for live Codex and board events. The official Codex protocol is never exposed directly.

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

Use EAS Build or local native toolchains for installable Android/iOS binaries.

## Security notes

- The gateway binds to loopback only and requires a bearer credential on every HTTP and WebSocket request.
- Remote routes expose only explicit board and Codex operations; they do not expose arbitrary shell or app-server stdio access.
- Treat pairing QR codes as secrets.
- `npm audit` currently reports advisories inherited through Expo/Metro build tooling. The suggested automatic remediation downgrades Expo across major SDK versions, so it is intentionally not applied; update when Expo publishes a compatible dependency chain.

See [PLAN.md](./PLAN.md) for the original MVP scope.

## License

MIT. See [LICENSE](./LICENSE).
