import { automationOutcome } from "@codex-board/protocol";
import { RetryAutomationButton } from "./RetryAutomationButton";
import type { BoardNotification } from "@codex-board/protocol";
import { MarkdownContent } from "./MarkdownContent";

export function AutomationResultDialog({ notification, onClose, onOpenThread, onBackToList }: {
  notification: BoardNotification;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
  onBackToList?: () => void;
}) {
  const result = notification.automation;
  if (!result) return null;
  const outcome = automationOutcome(result.status);
  const failed = outcome.tone !== "success";
  return (
    <div className="dialog-backdrop automation-result-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="automation-result-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-result-title">
        <header>
          <div className={`result-status-icon ${outcome.tone}`}>{outcome.tone === "unknown" ? "?" : failed ? "!" : "✓"}</div>
          <div>
            <span className="eyebrow">Automation result</span>
            <h2 id="automation-result-title">{result.name}</h2>
            <p>{outcome.label}{result.durationMs ? ` · ${Math.max(1, Math.round(result.durationMs / 1000))}s` : ""}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="automation-result-body"><MarkdownContent>{result.result}</MarkdownContent></div>
        <footer>
          <time>{new Date(notification.createdAt).toLocaleString()}</time>
          <div>
            {outcome.retryable && result.id && <RetryAutomationButton id={result.id} onAccepted={onClose}/>}
            {onBackToList && <button className="button secondary" onClick={onBackToList}>Back to results</button>}
            <button className="button secondary" onClick={onClose}>Close</button>
            {notification.threadId && <button className="button primary" onClick={() => onOpenThread(notification.threadId!)}>Open full conversation</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
