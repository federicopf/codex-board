# Codex Board — repository instructions

## Purpose and source of truth

Codex Board is an unofficial open-source Windows desktop board/chat client for local Codex tasks, with a companion Expo mobile app. The goal is to work from Board and mobile without requiring Codex Desktop as the daily UI.

Read this file before changing the project. Use `README.md` for setup and `PLAN.md` for the original MVP intent; the current implementation and tests take precedence over outdated descriptions. Do not treat the original plan as a list of unimplemented features.

Communicate with the owner in concise Italian. Explain outcomes, actual verification and remaining limitations. Never describe an untested feature as “100% solid”.

## Token-efficient workflow

- Treat the Codex skill `codex-token-optimizer` as the default workflow for coding tasks on this repository.
- Preflight every non-trivial change with one sentence: expected outcome, task type and probable module.
- Before opening many files, define the smallest useful scope and likely ownership area.
- Read targeted context only: manifests, routes/adapters, tests and files directly connected to the request.
- Prefer concise command output:
  - `git status --short`
  - `git diff --stat`
  - `git diff --name-only`
  - targeted `rg` searches
  - filtered logs with `tail`, `sed -n` or an error pattern
- Avoid reading generated folders, dependencies, runtime logs, lockfiles and compiled assets unless the task explicitly requires them.
- Keep the incremental repository map in `docs/repo-map.md`. Update it when discovering a stable module boundary, important entry point, reliable focused test or pattern to avoid.
- Do not save tokens by skipping verification. Choose the smallest verification that covers the risk of the change.

## Locate the correct checkout

- Resolve the repository root using Git and verify that it contains the root `package.json`, `src-tauri/` and `apps/mobile/` before editing or building.
- At the time of writing, the working project is `C:\Users\Asus\Desktop\codex-board`. A similarly named `C:\Users\Asus\Documents\codex-board` has previously been selected accidentally and is not the application checkout. Do not assume either path forever: verify first.
- Preserve pre-existing and uncommitted changes. Do not reset or overwrite unrelated work.

### Working from WSL on the Windows checkout

- The same checkout is accessible in WSL at `/mnt/c/Users/Asus/Desktop/codex-board`; this is not a separate copy. Prefer WSL for EAS CLI/account operations as well as the mandatory WSL Git workflow.
- From Windows, use `wsl -- bash -lc 'cd /mnt/c/Users/Asus/Desktop/codex-board && <command>'`. From a WSL terminal, `cd /mnt/c/Users/Asus/Desktop/codex-board`.
- Use Linux Node/npm for WSL commands; verify with `command -v node`, `node --version`, `command -v npm`. Do not accidentally invoke Windows Node through the inherited PATH.
- WSL access and EAS CLI execution were verified. `eas login` can reuse an existing WSL login; check `npx --yes eas-cli@latest whoami` before requesting another login. Never request passwords in chat. Authentication alone does not link an EAS project or configure OTA updates.
- At verification WSL had Node 20.19.6, below the project's Expo SDK 57 requirement. Upgrade/select a compatible Linux Node version before Expo builds/exports; successful EAS login does not establish build readiness.
- Do not run Linux and Windows dependency installation concurrently against the shared `node_modules`. Native/platform-specific dependencies may differ. Keep Windows Tauri/MSVC release builds on Windows unless an explicit alternative is configured.

## Architecture and ownership

This is an npm-workspaces monorepo, not two independent apps.

| Area | Responsibility |
| --- | --- |
| `src/` | Desktop React/TypeScript UI, Vite, Tauri command adapter |
| `src/App.tsx`, `src/BoardWorkspace.tsx` | Desktop orchestration, project boards and cards |
| `src/ChatPanel.tsx`, `src/MarkdownContent.tsx`, `src/lib/` | Chat rendering, event reduction and shared desktop view logic |
| `src-tauri/src/lib.rs` | Tauri commands and application wiring |
| `src-tauri/src/codex/` | Codex app-server process, protocol, DTOs and turn coordinator |
| `src-tauri/src/remote.rs` | Authenticated HTTP/WebSocket gateway, shared board configuration, Tailscale integration |
| `src-tauri/src/automations.rs` | Persistent scheduling and category pipeline execution |
| `src-tauri/src/notifications.rs`, `persistence.rs` | Persistent Inbox and crash-safe storage/recovery |
| `apps/mobile/` | Expo/React Native client |
| `apps/mobile/src/api.ts`, `connection.ts` | Remote command adapter, pairing and live connection |
| `apps/mobile/src/MobileBoardHome.tsx`, `theme.ts` | Mobile dashboard and theme |
| `packages/protocol/src/index.ts` | Shared remote contracts, pairing and title helpers |
| `scripts/` | Real Codex protocol verification tools |
| `.github/workflows/` | Build/publication workflows |

- Desktop calls local Tauri commands. Mobile calls the Board gateway over authenticated HTTP and receives live events over WebSocket.
- Rust owns the Board-managed `codex app-server` child process, queues, automation execution and shared persistence. Do not introduce another runner per client.
- The Board gateway is our transport adapter, not a public OpenAI REST API. Do not expose raw app-server stdio or arbitrary shell execution remotely.
- Codex Desktop can use a different runner. Reading local history does not guarantee bidirectional live updates or official Codex Remote/mobile integration. Do not promise this synchronization.
- Keep desktop/mobile operation contracts aligned. Add a capability through the Rust core, appropriate Tauri command, authenticated remote route, shared types and both client adapters where applicable.

## Product invariants

### Projects, categories and titles

- Project boards are first-class workspaces, not merely project filters. Preserve the selected project and the optional all-projects overview.
- Categories are arbitrary user-defined title prefixes before the first exact ` - ` separator. Never hardcode a standard workflow list or special-case only `WIP`.
- Tasks without a valid prefix belong to `Uncategorized`.
- Preserve custom category order; do not order categories by task count.
- Empty categories remain stored and available for moves/management, but must not clutter the desktop or mobile dashboard. Hiding is not deletion.
- Move dialogs must offer an existing category or creation of a new one. Keep quick category ordering and category renaming available.
- Moving a card changes the real persisted Codex task title, not just frontend state. Confirm the server result before presenting success.
- Renaming a conversation changes only its display title, preserving category, project, history and identity. Use `threadNameWithTitle` and fetch the latest thread before composing the new name; do not overwrite a recently changed category using stale UI state.
- Use the native conversation fork operation, never copy messages into an unrelated new task as a substitute. Preserve project/category and support branching from completed turns.

### Chat and execution

- Keep the chat inside Board. Do not restore “Open in Codex” as an ordinary action: the owner removed it to avoid conflicting runners.
- Keep typed input responsive. Isolate composer state from expensive history rendering; avoid rebuilding the full conversation on every keystroke.
- Opening/reopening chat should show the latest messages promptly, not visibly start at the first message and slowly scroll through all history.
- Only auto-follow new output when appropriate; do not force-scroll a user who is reading older messages.
- Render Markdown clearly and safely. Technical activity is collapsible by default; Codex UI directives such as `::git-stage{...}` must not appear as broken layout or accidental actionable commands.
- Follow-up messages use the backend-owned persistent FIFO queue shared by desktop and mobile. Never start competing writers or create independent frontend queues.
- Preserve streaming, interruption, error recovery, manual approvals and user-input questions. Automatic approval is an explicit supported mode, not a reason to remove manual approval choices.
- Avoid sending diagnostic prompts into real user tasks without explicit authorization: this changes history and consumes turns.

### Automations, pipelines and Inbox

- Scheduling runs on the PC while Board is running, not on the phone and not while the PC is off.
- Keep automation listing/orchestration separate from creation. Separate recurring task creation from category pipeline creation.
- Preserve supported interval, precise-date and weekly-calendar schedules. Consult the current action types before extending schedule behavior.
- Automations must use the normal coordinator/queue when a task is already running.
- Completion notifications for automations open a quick, concise result modal. Preserve the implicit result-only/succinct instruction without adding it to the visible editable user prompt.
- In-app notifications/Inbox are wanted; OS/mobile push notifications are not currently requested.
- Do not implement the withdrawn “daily review until a date, then automatically move to Closed” feature unless explicitly requested again.

## UI expectations

- Implement relevant functionality on both desktop and mobile; do not assume desktop completion means mobile parity.
- Favor an intuitive, uncluttered interface with clear separation of responsibilities.
- Separate desktop helper actions (Inbox, Help, Remote) from operational controls (automations, refresh). Place project/status controls where they do not overload the topbar.
- Use centered accessible icon buttons for close/back/edit actions; supply labels, adequate hit areas, consistent alignment and padding. Avoid narrow text buttons that wrap “Cancel” or “Close”.
- Keep mobile workspace summary, category picker and task content compact; avoid flex layouts that distribute large blank gaps.
- Preserve the illustrated first-run guide and reopening it from Help.
- Follow existing icons, themes, dialog patterns and error adapters rather than adding parallel systems.

## Remote access and security

- The gateway binds only to `127.0.0.1:47821`. Tailscale provides a private tailnet proxy on `47822`.
- Never replace this with an unauthenticated public port, ngrok tunnel or Tailscale Funnel without a new explicit decision.
- Authenticate remote operations and live connections. Pairing QR codes and bearer tokens are secrets: do not print them, commit them or include them in screenshots/logs.
- Mobile stores pairing credentials through `expo-secure-store`.
- The Metro/Expo Go QR launches a development app; the Board pairing QR authorizes remote access. Explain them separately.
- Preserve crash-safe JSON persistence, last-known-good backups and recovery. Do not silently discard queues, Inbox or scheduling state.

## Development and verification

Run dependency installation from the repository root (`npm ci` for a clean locked install; `npm install` when intentionally changing dependencies). The repository uses React 19, Tauri 2 and Expo SDK 57 at the time of writing; check manifests for exact versions.

```powershell
# Frontend unit/component tests
npm test
# Desktop typecheck and production web bundle
npm run build
# Rust tests
cargo test --manifest-path .\src-tauri\Cargo.toml
# Mobile typecheck
npm run mobile:typecheck
# Desktop development
npm run tauri dev
# Expo Go development
npm run mobile
# Windows release/NSIS installer
npm run tauri build
# Optional EAS APK build
npm run mobile:apk
```

For mobile bundle verification, run `npx expo export --platform android` inside `apps/mobile`. Use a temporary output path if needed and keep generated assets out of commits.

- Add regression tests for changed title/category helpers, protocol contracts, reducers and scheduling behavior. Keep Rust serialization and mobile camelCase contracts consistent.
- For cross-client changes run tests, desktop build and mobile typecheck; run Rust tests when changing the core. An APK/export compilation is not a device interaction test: report the distinction.
- `scripts/verify-app-server.mjs` checks the real protocol; inspect any diagnostic script before running it to understand whether it resumes or mutates tasks.
- After a Codex CLI upgrade, regenerate schemas as needed with `codex app-server generate-json-schema --out <schema-directory>` and verify against the installed runtime instead of guessing protocol fields.
- Do not apply `npm audit fix --force` blindly: inherited Expo tooling advisories may suggest an incompatible SDK downgrade.

## Builds, installation and Git

- A current source checkout is not proof that the installed Windows app is current. Verify the installed executable separately.
- Windows install location is normally `%LOCALAPPDATA%\Codex Board\codex-board.exe`; the NSIS installer is under `src-tauri/target/release/bundle/nsis/`. Verify actual paths before acting.
- Before closing/replacing a running app, check for active turns. Do not kill active work to install an update; prefer graceful shutdown when idle.
- Do not bump versions, create tags, publish releases, upload OTA updates or trigger external builds unless requested. The owner's default publication preference is commit/push only.
- Git remote: `git@github.com:federicopf/codex-board.git`. Verify the configured remote and branch rather than assuming local `main`: the local branch has also been named `codex/main`, tracking remote `main`.
- **All commits and pushes must use direct Git from WSL, not GitHub CLI (`gh`) and not Windows Git.** Inspect the WSL checkout through `/mnt/c/...`, stage only intended files, review the diff and push the verified branch to remote `main` when requested.
- Do not amend/rewrite history, force-push, discard user changes or create a release merely because a push was requested.

## EAS Update / OTA status

OTA updates have been discussed but are not configured at the time of writing. `apps/mobile/eas.json` contains preview APK and production build profiles; it does not yet establish update channels. Verify `expo-updates`, `updates.url`, `runtimeVersion`, EAS project linkage and authenticated Expo account before claiming OTA support.

The agreed direction is preview/production update channels, compatible-runtime targeting and an unobtrusive “update available / restart” UI. A first OTA-enabled binary must be installed; later compatible JS/asset changes can be delivered OTA. Native dependencies, permissions and runtime changes still require a new binary. OTA does not update the Windows Rust backend. Never publish an OTA update as a side effect of unrelated work.
