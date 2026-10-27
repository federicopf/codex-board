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
- Bozze chat: `packages/protocol/src/chatDrafts.ts` mantiene testo e allegati per thread indipendentemente dal componente, serializza/coalesca i salvataggi e rimuove solo il contenuto accettato dal backend (non la digitazione successiva). Desktop usa IndexedDB in `src/lib/chatDrafts.ts`; mobile usa `expo-file-system/legacy` gia incluso da Expo, file privati con backup e scope per URL del PC in `apps/mobile/src/chatDrafts.ts`. Salvataggio su navigazione/background, nessuna sincronizzazione delle bozze tra dispositivi.
- Tastiera chat mobile: `ChatKeyboardFrame.tsx` abilita `height` su Android e `padding` su iOS, misurando la posizione reale del viewport per includere safe area/banner; nessuna altezza tastiera hardcoded o modifica del manifest nativo. Verificare sul telefono oltre ai test di layout.
- Immagini Codex: `turn_input` in `src-tauri/src/codex/mod.rs` e condiviso da nuova chat e messaggi/coda; il runtime 0.146.1 richiede `{type:"image",url:"..."}`, non `image:{url:...}`. Le sole route HTTP di creazione/invio accettano fino a 32 MiB. Test: `ChatComposer.test.tsx`, `chatDrafts.test.ts`, `mobileChatDrafts.test.ts`, `mobileKeyboard.test.tsx` e test Rust del contratto immagini.
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
- Report automazioni: `src-tauri/src/automation_result.rs` definisce schema JSON per-turno `{status: success|failed, summary, noteworthy}` e istruzione implicita. Il coordinatore applica schema/istruzione anche agli elementi gia in coda; nessuna modifica ai prompt salvati o ai turni manuali. Errori tecnici e interruzioni prevalgono sul JSON; report assenti/invalidi diventano `unknown`, mai successi impliciti. I report validi sono tollerati fino a 500 parole per campo e non devono essere tagliati a meta frase da `automation_result.rs`, `automations.rs` o `notifications.rs`.
- Esiti e rilancio: `NotificationStore` associa il contesto prima della richiesta di avvio, raccoglie `item/completed` anche se `turn/completed.items` e vuoto e pubblica un solo `board/automation/completed` normalizzato. `AutomationStore` persiste `lastResult`, recupera errori legacy e calcola `runState` dalla coda/coordinatore. `retry_automation` e `POST /v1/automations/{id}/retry` autenticato rilanciano senza cambiare prossima occorrenza/pausa e rifiutano duplicati o risultati ormai riusciti. Conferma esplicita nei due client; niente retry automatico. Vedi `docs/automation-outcomes.md`.

### Mobile Expo

- Tipo: Expo/React Native companion app per Board via gateway autenticato.
- Entry point: `apps/mobile/App.tsx`, `apps/mobile/src/MobileBoardHome.tsx`, `apps/mobile/src/api.ts`, `apps/mobile/src/connection.ts`.
- Manifest: `apps/mobile/package.json`, `apps/mobile/app.json`, `apps/mobile/eas.json`.
- Test/verifiche: `npm run mobile:typecheck`; per bundle Android usare `npx expo export --platform android` da `apps/mobile` quando serve.
- Pattern: Expo Go QR e Board pairing QR sono cose diverse. EAS Update usa il progetto `@f.germani06/codex-board-mobile` e canali `preview`/`production`. La versione JavaScript mobile 0.2.4 mantiene il runtime esplicito `0.2.2` per raggiungere gli APK OTA esistenti; cambiare il runtime richiede una nuova build nativa.
- Inbox: desktop e mobile separano le notifiche ordinarie dai risultati delle automazioni tramite due tab, mantenendo un unico store persistente backend.
- Navigazione: `ProjectHome.tsx` e la schermata iniziale mobile per scegliere il workspace; `MobileBoardHome.tsx` rappresenta una singola board e torna alla selezione progetti con back UI/hardware.
- `MobileNavigation.tsx` mantiene accessibili progetti, Inbox, workflow e impostazioni; `MobileActionSheet.tsx` raccoglie le azioni secondarie. Chat e board sono schermate normali, gli strumenti sono modali con `onRequestClose`.
- Icone: `MobileIcon.tsx` e l'unico adapter mobile per Feather (famiglia lineare unica, font scaling disabilitato); usare nomi Feather in tutte le schermate/azioni. Importare il modulo diretto per non includere tutti i font di `@expo/vector-icons`. Nessuna nuova dipendenza nativa.
- Impostazioni turno: `BoardConfig.turnSettings` rimane solo il default legacy; le scelte della singola chat sono in `BoardConfig.threadTurnSettings[threadId]`, aggiornate da Tauri `set_thread_turn_settings` o `PUT /v1/threads/{id}/turn-settings`. I salvataggi della board preservano entrambe le mappe sotto lo stesso lock Rust.
- `packages/protocol/src/turnSettings.ts` contiene `ThreadTurnSettingsSync`, che isola le patch per chat, ignora snapshot vecchi e attende la conferma prima dell'invio; `src/lib/turnSettings.ts` collega lo store alla UI desktop.
- Ownership mobile: `apps/mobile/src/projectOwnership.ts` normalizza i path Windows/WSL come desktop e separa thread generici dai thread clienti; test mirati in `src/lib/mobileProjectOwnership.test.ts`.
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
