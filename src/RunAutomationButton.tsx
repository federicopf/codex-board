import { useRef, useState } from "react";
import { runAutomationNow } from "./api";
import { Icon } from "./ui/Icon";

export function RunAutomationButton({ id, name, disabled = false, onAccepted }: { id: string; name: string; disabled?: boolean; onAccepted?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function run() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await runAutomationNow(id); setConfirming(false); onAccepted?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="automation-retry">
    {confirming ? <div className="automation-retry-confirm" role="alert">
      <span>Run “{name}” now with its saved settings? This may change the linked chat or project. The regular schedule and pause state will not change.</span>
      <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel run</button>
      <button type="button" className="button primary" disabled={busy || disabled} onClick={() => void run()}>{busy ? "Starting…" : "Confirm run"}</button>
    </div> : <button type="button" className="automation-edit" aria-label={`Run ${name} now`} disabled={disabled || busy} onClick={() => setConfirming(true)}><Icon name="play" width={16} height={16}/>Run now</button>}
    {error && <p className="automation-form-error" role="alert">{error}</p>}
  </div>;
}
