import type { BoardNotification } from "@codex-board/protocol";
import { MarkdownContent } from "./MarkdownContent";

export function AutomationResultDialog({ notification, onClose, onOpenThread }: {
  notification: BoardNotification;
  onClose: () => void;
  onOpenThread: (threadId: string) => void;
}) {
  const result = notification.automation;
  if (!result) return null;
  const failed = result.status === "failed";
  return (
    <div className="dialog-backdrop automation-result-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="automation-result-dialog" role="dialog" aria-modal="true" aria-labelledby="automation-result-title">
        <header>
          <div className={`result-status-icon ${failed ? "failed" : ""}`}>{failed ? "!" : "✓"}</div>
          <div>
            <span className="eyebrow">Automation result</span>
            <h2 id="automation-result-title">{result.name}</h2>
            <p>{failed ? "Finished with an error" : "Completed successfully"}{result.durationMs ? ` · ${Math.max(1, Math.round(result.durationMs / 1000))}s` : ""}</p>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">×</button>
        </header>
        <div className="automation-result-body"><MarkdownContent>{result.result}</MarkdownContent></div>
        <footer>
          <time>{new Date(notification.createdAt).toLocaleString()}</time>
          <div>
            <button className="button secondary" onClick={onClose}>Close</button>
            {notification.threadId && <button className="button primary" onClick={() => onOpenThread(notification.threadId!)}>Open full conversation</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
