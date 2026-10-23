# Automation outcomes and manual retry

Automated turns receive a per-turn Codex app-server `outputSchema` and an implicit few-shot instruction. Saved user prompts remain unchanged. The final object has exactly three keys:

```json
{"status":"success","summary":"Completata la scansione CloudWatch: trovato un deadlock. Nei log non compare un recupero.","noteworthy":["Un messaggio è fallito per deadlock MySQL; gli altri due sono stati elaborati."]}
```

`success` means the requested objective was achieved. For an audit, scan, investigation or report, completing the inspection and accurately reporting findings is success even when the inspected system contains failures; those findings belong in `noteworthy`. Use `failed` when the inspection/report itself was incomplete, or when a requested repair/recovery remains incomplete. A technically completed turn alone is not a business success. Technical failures and interruptions override a success report. Missing, malformed or overlong output produces `unknown` (Unverified). The schema constrains the format, not the truth of the model's claims.

Summary: 2–3 sentences, at most 60 words; noteworthy has at most four concise items, each at most 60 words. The parser tolerates a short prose preamble before a single valid JSON object, since some model responses fail to follow outputSchema exactly. Prompt examples cover recovered errors, completed diagnostics with findings, unresolved requested repairs, no changes, missing access and failing required checks. Explicit deliverables remain complete; the limit only concerns the final notification. No schema or implicit instruction is applied to manual messages.

Both clients display the last outcome separately from the enabled/paused schedule. The backend persists the summary/outcome and reconstructs live queued/running state from the shared coordinator. Old technical errors can migrate to failed results; old plain-text completed results are not retroactively certified as successes.

Retry is explicit and confirmed because earlier work may have partially taken effect. A new attempt uses the current saved action/prompt, never creates a replacement automation, and preserves pause and the next scheduled occurrence. Active runs and obsolete retries after success are rejected. If a start failed and its original entry is still first in an idle queue, retry wakes that same entry (with its existing submitted prompt), without creating another occurrence. Queued entries behind ongoing/earlier work stay in FIFO order. Delayed category pipelines only retry tasks whose existing category delay has elapsed; successful moves leave the source category. No automatic business retry loop is introduced.

The PC must run a backend containing this change. An older gateway receives no fallback turn or client-side runner; mobile explains that the PC needs updating. Source changes require a Windows update and a compatible mobile update before becoming available in installed apps.

Verification: `cargo test --manifest-path src-tauri/Cargo.toml`, `npm test`, `npm run build`, `npm run mobile:typecheck`; synthetic local-event tests do not send diagnostic turns into user conversations.
