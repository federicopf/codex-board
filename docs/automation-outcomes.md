# Automation outcomes and manual retry

Automated turns receive a per-turn Codex app-server `outputSchema` and an implicit few-shot instruction. Saved user prompts remain unchanged. The final object has exactly two keys:

```json
{"status":"failed","summary":"Report non aggiornato: accesso al servizio scaduto."}
```

`success` means the model reports that the requested work and relevant checks succeeded (including no changes needed). `failed` includes business blockers, partial/incomplete work and failed checks. A technically completed turn alone is not a business success. Technical failures and interruptions override a success report. Missing, malformed or overlong output produces `unknown` (Unverified). The schema constrains the format, not the truth of the model's claims.

Summary: at most 40 words. Four prompt examples cover success, no changes, missing access and failing tests. Explicit deliverables remain complete; the limit only concerns the final notification. No schema or implicit instruction is applied to manual messages.

Both clients display the last outcome separately from the enabled/paused schedule. The backend persists the summary/outcome and reconstructs live queued/running state from the shared coordinator. Old technical errors can migrate to failed results; old plain-text completed results are not retroactively certified as successes.

Retry is explicit and confirmed because earlier work may have partially taken effect. A new attempt uses the current saved action/prompt, never creates a replacement automation, and preserves pause and the next scheduled occurrence. Active runs and obsolete retries after success are rejected. If a start failed and its original entry is still first in an idle queue, retry wakes that same entry (with its existing submitted prompt), without creating another occurrence. Queued entries behind ongoing/earlier work stay in FIFO order. Delayed category pipelines only retry tasks whose existing category delay has elapsed; successful moves leave the source category. No automatic business retry loop is introduced.

The PC must run a backend containing this change. An older gateway receives no fallback turn or client-side runner; mobile explains that the PC needs updating. Source changes require a Windows update and a compatible mobile update before becoming available in installed apps.

Verification: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm test`, `npm run build`, `npm run mobile:typecheck`; synthetic local-event tests do not send diagnostic turns into user conversations.
