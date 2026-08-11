# Codex Board — MVP desktop Windows open source

## Sintesi

Creare un’app Tauri 2 + React + TypeScript + Rust, con licenza MIT, che gira nativamente su Windows e usa il CLI Windows ufficiale nel `PATH`. Il repository resterà inizialmente nella cartella Windows corrente; lo spostamento nel filesystem WSL avverrà dopo l’MVP, mantenendo le release Windows compilate con toolchain nativa Windows.

L’app non avrà server HTTP, database, autenticazione propria o integrazioni ulteriori. Codex resterà l’unica source of truth: lo stato della card sarà codificato esclusivamente nel nome reale del thread.

## Implementazione

- Preparare la toolchain Windows: Node.js LTS, Rust stable MSVC, Microsoft C++ Build Tools, WebView2 e CLI Codex standalone installato nel `PATH`. Il binario dell’app Microsoft Store attualmente visibile non è sufficiente perché non risulta eseguibile direttamente dalla shell.
- Creare il progetto Tauri 2 con Vite, React e TypeScript, configurato come applicazione Windows x64 `Codex Board`.
- Prima della board, generare gli schema version-specifici con `codex app-server generate-json-schema` o `generate-ts`, verificare manualmente handshake e `thread/list`, e mostrare temporaneamente i DTO raw durante lo sviluppo. Il protocollo documentato è JSONL su stdin/stdout e richiede `initialize` seguito da `initialized`. [Codex App Server](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)

### Integrazione Rust

- Organizzare `src-tauri/src/codex/` in processo, protocollo e tipi.
- `CodexClient` sarà stato gestito da Tauri e:
  - eseguirà `codex app-server`;
  - manterrà stdin aperto;
  - leggerà stdout riga per riga;
  - assegnerà ID incrementali;
  - abbinerà risposte anche fuori ordine tramite una mappa di richieste pendenti;
  - ignorerà in modo sicuro le notification non usate;
  - leggerà stderr separatamente per diagnostica;
  - fallirà tutte le richieste pendenti se il processo termina.
- All’avvio completare `initialize` con `clientInfo` di Codex Board e inviare `initialized`, senza abilitare API sperimentali.
- Esporre a React solamente:
  - `list_threads() -> Result<Vec<ThreadDto>, CodexErrorDto>`;
  - `rename_thread(thread_id, new_name) -> Result<(), CodexErrorDto>`.
- `list_threads` percorrerà tutte le pagine di `thread/list`, con thread non archiviati, ordinamento `recency_at desc` e source kinds interattivi `cli`, `vscode`, `appServer`; saranno esclusi thread exec, sub-agent e review interne.
- `ThreadDto` conterrà soltanto `id`, `name`, `preview`, `cwd` e gli eventuali campi minimi necessari per ordinamento/debug.
- `rename_thread` invierà `thread/name/set` con `{ threadId, name }`; il risultato vuoto indica successo.
- Alla chiusura normale della finestra, inviare la terminazione al child, attenderne l’uscita e applicare un kill di fallback. Anche `Drop` effettuerà cleanup best-effort.
- Se il processo muore, il successivo refresh potrà ricrearlo e ripetere l’handshake. Un rename con risultato incerto non verrà ritentato automaticamente: la UI farà rollback e ricaricherà i thread.
- Errori serializzati con codici stabili: `CLI_NOT_FOUND`, `START_FAILED`, `HANDSHAKE_FAILED`, `PROTOCOL_ERROR`, `REQUEST_FAILED`, `PROCESS_EXITED`.

### Modello UI e titoli

- Centralizzare in `src/lib/threadStatus.ts`:
  - categorie dinamiche derivate dal prefisso del titolo;
  - `parseThreadTitle(title)`;
  - `buildThreadTitle(status, displayTitle)`.
- Parsing case-sensitive: qualsiasi valore non vuoto prima del primo separatore esatto ` - ` è una categoria, inclusi `To Plan`, `To Monitor`, `Stall`, `WIP` e prefissi futuri non ancora noti.
- Per `Uncategorized`, il builder restituisce il titolo senza prefisso.
- Il titolo effettivo sarà il primo valore non vuoto tra `thread.name`, `thread.preview` e `Untitled thread`. Spostare un thread privo di `name` creerà quindi un nome esplicito basato sulla preview.
- Il progetto sarà derivato dal `cwd`, senza interrogare Git o richiedere che il path esista localmente:
  - chiave interna: path completo normalizzato;
  - etichetta: ultimo segmento;
  - basename duplicati: aggiungere il segmento padre;
  - `cwd` assente: `Unknown project`;
  - selezione iniziale: `All projects`.
- Costruire colonne dinamiche per tutti i prefissi osservati, più `Uncategorized`, card compatte e dropdown progetto. Mostrare il nome progetto in piccolo sulle card solo quando è selezionato `All projects`.
- Ogni card offrirà un’azione `Open` che apre il thread corrispondente nell’app Codex tramite il deep link `codex://threads/<threadId>`.
- Usare `@dnd-kit/core`: colonne droppable e card draggable, senza riordinamento nella stessa colonna.
- Al drop:
  1. calcolare il nuovo titolo;
  2. aggiornare card e colonna in modo ottimistico;
  3. disabilitare ulteriori drag della stessa card;
  4. chiamare `rename_thread`;
  5. su successo ricaricare in background per riconciliare la source of truth;
  6. su errore ripristinare titolo/colonna e mostrare un banner non invasivo.
- Drag nella stessa colonna: nessuna chiamata. Drag verso Uncategorized: rimozione del prefisso.
- Stati UI: caricamento iniziale, board vuota, errore recuperabile con Refresh e schermata dedicata “Codex CLI not found” con istruzione di installazione.
- Tema chiaro/scuro tramite `prefers-color-scheme`, stile minimale tipo Linear/GitHub Projects.

## Test e accettazione

- Test TypeScript con Vitest:
  - parsing e builder per prefissi arbitrari;
  - titoli sconosciuti, vuoti e contenenti altri trattini;
  - raggruppamento e disambiguazione progetti;
  - filtro `All projects`;
  - optimistic update, successo, rollback e drop nella stessa colonna.
- Test Rust:
  - handshake obbligatorio;
  - matching di risposte fuori ordine;
  - notification intercalate;
  - paginazione completa di `thread/list`;
  - errori JSON-RPC, JSON non valido ed EOF;
  - CLI assente;
  - terminazione del child e risoluzione delle richieste pendenti.
- Verifica manuale con CLI reale prima della rifinitura grafica:
  - confrontare i thread raw con quelli visibili nell’app Codex Windows;
  - rinominare un thread di prova con `thread/name/set`;
  - verificare il nuovo nome nell’app Codex normale.
- Build finale nativa Windows x64 con installer NSIS per utente corrente, senza privilegi amministrativi e senza firma digitale nell’MVP. Tauri raccomanda la build Windows nativa rispetto alla cross-compilazione da Linux. [Prerequisiti Windows](https://v2.tauri.app/start/prerequisites/) e [installer NSIS](https://v2.tauri.app/distribute/windows-installer/)
- Definition of Done:
  - installazione e avvio con doppio click;
  - caricamento automatico dei thread reali;
  - filtro progetto;
  - colonne dinamiche corrette per tutti i prefissi presenti;
  - drag che modifica il nome reale;
  - refresh e rollback affidabili;
  - nessun `codex app-server` residuo dopo la chiusura.

## Assunzioni e limiti

- Licenza MIT con `LICENSE`, README di setup/build e indicazione che il progetto è non ufficiale e non affiliato a OpenAI.
- Il CLI Windows usa il normale `CODEX_HOME` dell’utente e deve vedere gli stessi thread dell’app Codex Windows; questa compatibilità viene validata nel primo milestone prima di costruire la board.
- Nessuna schermata impostazioni o selezione manuale del binario nell’MVP.
- Nessun updater, code signing, pubblicazione Microsoft Store o CI di release.
- Dopo l’MVP il repository potrà essere clonato sotto `~/code/codex-board` in WSL per l’editing con VS Code Remote. Le build distributive Windows continueranno da un checkout Windows o da un runner Windows, evitando la cross-compilazione Tauri da WSL.
- Restano esclusi database, backend, rete, login, mobile, ricerca avanzata, metadata aggiuntivi, integrazioni esterne e qualsiasi funzione non necessaria a vedere, raggruppare o rinominare i thread.
