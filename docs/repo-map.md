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
- Creazione task: `src/NewTaskDialog.tsx` inoltra le immagini selezionate insieme al primo messaggio tramite `create_thread`; il backend costruisce lo stesso input immagine usato dai messaggi successivi.
- Progetti: le cartelle registrate persistono in `BoardConfig.projects`; `src/lib/projects.ts` unisce queste board ai progetti scoperti dalle conversazioni, così le board vuote non scompaiono.

### Tauri / Rust core

- Tipo: backend locale Rust per comandi Tauri, processo `codex app-server`, gateway remoto, automazioni e persistenza.
- Entry point: `src-tauri/src/lib.rs`, `src-tauri/src/codex/`, `src-tauri/src/remote.rs`, `src-tauri/src/automations.rs`.
- Manifest: `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json`.
- Test/verifiche: `cargo test --manifest-path .\src-tauri\Cargo.toml`; build release con `npm run tauri build` solo quando serve l'installer.
- Pattern: una sola coda/coordinatore backend per desktop, mobile e automazioni; evitare writer concorrenti.
- Automations: `src-tauri/src/automations.rs` runs the periodic scheduler and persists next-run timestamps; missed interval/calendar slots collapse into one catch-up, while the coordinator coalesces duplicate pending messages by automation ID.
- Editing: `AutomationStore.update`, Tauri `update_automation` and authenticated `PATCH /v1/automations/{id}` update workflows in place, serializing against scheduler submission. Shared `packages/protocol/src/automationEditing.ts` prefills both clients and preserves timestamp precision/calendar timezone. Metadata edits preserve next run, pause and history; pipeline source changes reset category-entry tracking. Queued/running turns retain their submitted prompt. Regression tests: `src/AutomationsDialog.test.tsx`, `src/lib/automationEditing.test.ts`, Rust automation tests.
- Report automazioni: `AUTOMATION_RESULT_INSTRUCTION` in `src-tauri/src/codex/coordinator.rs` impone massimo 3 punti e 40 parole nella risposta finale, oppure una sola frase senza novita. La regola viene aggiunta all'invio (anche dalla coda), senza modificare i prompt salvati o limitare i deliverable richiesti; desktop e mobile ricevono lo stesso risultato.

### Mobile Expo

- Tipo: Expo/React Native companion app per Board via gateway autenticato.
- Entry point: `apps/mobile/App.tsx`, `apps/mobile/src/MobileBoardHome.tsx`, `apps/mobile/src/api.ts`, `apps/mobile/src/connection.ts`.
- Manifest: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/eas.json`.
- Test/verifiche: `npm run mobile:typecheck`; per bundle Android usare `npx expo export --platform android` da `apps/mobile` quando serve.
- Pattern: Expo Go QR e Board pairing QR sono cose diverse. EAS Update usa il progetto `@f.germani06/codex-board-mobile` e canali `preview`/`production`. La versione JavaScript mobile 0.2.4 mantiene il runtime esplicito `0.2.2` per raggiungere gli APK OTA esistenti; cambiare il runtime richiede una nuova build nativa.
- Inbox: desktop e mobile separano le notifiche ordinarie dai risultati delle automazioni tramite due tab, mantenendo un unico store persistente backend.
- Navigazione: `ProjectHome.tsx` e la schermata iniziale mobile per scegliere il workspace; `MobileBoardHome.tsx` rappresenta una singola board e torna alla selezione progetti con back UI/hardware.
- `MobileNavigation.tsx` mantiene accessibili progetti, Inbox, workflow e impostazioni; `MobileActionSheet.tsx` raccoglie le azioni secondarie. Chat e board sono schermate normali, gli strumenti sono modali con `onRequestClose`.
- Icone: `MobileIcon.tsx` e l'unico adapter mobile per Ionicons; importare il modulo Ionicons diretto per non includere tutti i font di `@expo/vector-icons`.
- Impostazioni turno: modello, effort, summary e service tier sono persistiti in `BoardConfig.turnSettings` e aggiornabili atomicamente tramite `/v1/turn-settings`, cosi desktop e mobile condividono la selezione.
- `packages/protocol/src/turnSettings.ts` serializza le patch, ignora snapshot vecchi e attende la conferma prima dell'invio; `src/lib/turnSettings.ts` collega lo stesso store alla UI desktop. I salvataggi della board preservano le preferenze correnti sotto lo stesso lock Rust.
- Compatibilita OTA: `apps/mobile/src/api.ts` riconosce i gateway precedenti senza `turnSettings`, conserva le scelte sul telefono in SecureStore e permette di continuare col modello ereditato dalla conversazione. La sincronizzazione completa si attiva con desktop 0.2.8.

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
