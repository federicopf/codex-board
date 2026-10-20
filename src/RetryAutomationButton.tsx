import { useRef, useState } from "react";
import { retryAutomation } from "./api";
import { Icon } from "./ui/Icon";

export function RetryAutomationButton({ id, disabled = false, onAccepted }: { id: string; disabled?: boolean; onAccepted?: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  async function retry() {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await retryAutomation(id); setConfirming(false); setSent(true); onAccepted?.(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <div className="automation-retry">
    {confirming ? <div className="automation-retry-confirm" role="alert">
      <span>Retry with current settings, or resume the saved queued attempt? Work may have been partially completed. The regular schedule and pause state will not change.</span>
      <button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel retry</button>
      <button type="button" className="button primary" disabled={busy || disabled} onClick={() => void retry()}>{busy ? "Starting…" : "Confirm retry"}</button>
    </div> : <button type="button" className="automation-edit" disabled={disabled || busy || sent} onClick={() => setConfirming(true)}><Icon name="refresh" width={16} height={16}/>{sent ? "Retry requested" : "Retry"}</button>}
    {error && <p className="automation-form-error" role="alert">{error}</p>}
  </div>;
}
