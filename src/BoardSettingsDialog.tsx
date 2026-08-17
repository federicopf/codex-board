import type { ApprovalMode } from "./lib/approvals";

export function BoardSettingsDialog({ approvalMode, onApprovalMode, onClose }: { approvalMode: ApprovalMode; onApprovalMode: (mode: ApprovalMode) => void; onClose: () => void }) {
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="board-settings-dialog" role="dialog" aria-modal="true" aria-labelledby="board-settings-title">
      <header><div><span className="eyebrow">Preferences</span><h2 id="board-settings-title">Board settings</h2><p>Configuration that affects how Codex Board works, not how tasks are filtered.</p></div><button className="icon-button" onClick={onClose}>×</button></header>
      <label><div><strong>Approvals</strong><small>Choose whether commands and file changes require confirmation.</small></div><select value={approvalMode} onChange={(event) => onApprovalMode(event.target.value as ApprovalMode)}><option value="auto">Auto approve</option><option value="ask">Ask every time</option></select></label>
      <footer><button onClick={onClose}>Done</button></footer>
    </section>
  </div>;
}
