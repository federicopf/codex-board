# Repo-map incrementale

Questa mappa serve a ridurre letture ripetitive della repository. Aggiornarla
quando una nuova scoperta e stabile e utile per task futuri.

## Uso rapido

1. Identificare il modulo o l'area toccata dalla richiesta.
2. Leggere solo manifest, route/adapters, test o file indicati per quell'area.
3. Escludere output generati, dipendenze locali, lockfile e log runtime.
4. Eseguire la verifica piu piccola che copre il rischio della modifica.

## Esclusioni predefinite

Non leggere o includere in diff estesi salvo necessita esplicita:

- `node_modules/`, `vendor/`
- `dist/`, `build/`, `.serverless/`, `coverage/`
- `src-tauri/target/`, `.expo/`
- log e cartelle runtime
- lockfile, archivi, asset compilati
- allegati temporanei non collegati

## Moduli

### Desktop UI

- Tipo: React 19 + TypeScript + Vite frontend per Tauri.
- Entry point: `src/App.tsx`, `src/BoardWorkspace.tsx`, `src/ChatPanel.tsx`.
- Manifest: `package.json`, `vite.config.ts`, `tsconfig*.json`.
- Test/verifiche: `npm test`, `npm run build`; test mirati in `src/*.test.tsx` e `src/lib/*.test.ts`.
- Pattern: mantenere composer chat isolato da render costosi; UI desktop e mobile devono restare allineate quando una capability e condivisa.

### Tauri / Rust core

- Tipo: backend locale Rust per comandi Tauri, processo `codex app-server`, gateway remoto, automazioni e persistenza.
- Entry point: `src-tauri/src/lib.rs`, `src-tauri/src/codex/`, `src-tauri/src/remote.rs`, `src-tauri/src/automations.rs`.
- Manifest: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
- Test/verifiche: `cargo test --manifest-path .\src-tauri\Cargo.toml`; build release con `npm run tauri build` solo quando serve l'installer.
- Pattern: una sola coda/coordinatore backend per desktop, mobile e automazioni; evitare writer concorrenti.

### Mobile Expo

- Tipo: Expo/React Native companion app per Board via gateway autenticato.
- Entry point: `apps/mobile/App.tsx`, `apps/mobile/src/MobileBoardHome.tsx`, `apps/mobile/src/api.ts`, `apps/mobile/src/connection.ts`.
- Manifest: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/eas.json`.
- Test/verifiche: `npm run mobile:typecheck`; per bundle Android usare `npx expo export --platform android` da `apps/mobile` quando serve.
- Pattern: Expo Go QR e Board pairing QR sono cose diverse; non promettere OTA finche `expo-updates`, runtime e EAS project non sono configurati.

### Shared protocol

- Tipo: contratti TypeScript condivisi da desktop, mobile e gateway.
- Entry point: `packages/protocol/src/index.ts`.
- Manifest: `packages/protocol/package.json`, root `package.json`.
- Test/verifiche: test TypeScript mirati sui helper condivisi, poi `npm test` se il contratto influenza piu client.
- Pattern: preservare compatibilita camelCase mobile e helper titolo/categoria come fonte condivisa.

### Build, release e Git

- Tipo: workflow locale Windows/WSL.
- Entry point: root scripts npm, `src-tauri/target/release/bundle/nsis/` per installer generato.
- Manifest: root `package.json`, `apps/mobile/eas.json`, `src-tauri/Cargo.toml`.
- Test/verifiche: scegliere fra typecheck, unit test, Rust test, export mobile, build Tauri in base al rischio.
- Pattern: commit e push solo da WSL con Git diretto; niente `gh`, niente force push, niente release/OTA/tag senza richiesta esplicita.

## Workflow

- Preflight: descrivere in una frase il risultato atteso e il modulo probabile.
- Routing: leggere questa mappa, poi pochi file mirati.
- Ricerca: usare `rg` o `find` con esclusioni.
- Output: limitare con `sed -n`, `tail`, `git diff --stat`, `git diff --name-only`.
- Verifica: preferire test mirati; ampliare solo per cambi condivisi o rischiosi.
- Chiusura: riportare file cambiati, comando di verifica e rischi residui.
