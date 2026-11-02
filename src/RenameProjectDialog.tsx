import { useState, type FormEvent } from "react";
import { asCodexError } from "./api";
import type { ProjectInfo } from "./lib/projects";

export function RenameProjectDialog({ project, onClose, onRename }: { project: ProjectInfo; onClose: () => void; onRename: (name: string) => Promise<void> }) {
  const [name, setName] = useState(project.label);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: FormEvent) {
    event.preventDefault();
    const next = name.trim();
    if (!next || next.length > 120 || busy) return;
    setBusy(true); setError(null);
    try { await onRename(next); onClose(); }
    catch (cause) { setError(asCodexError(cause).message); }
    finally { setBusy(false); }
  }
  return <div className="dialog-backdrop fork-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="new-task-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-project-title" onSubmit={(event) => void submit(event)}>
      <header><div><span className="eyebrow">Project board</span><h2 id="rename-project-title">Rename project</h2><p>Only the displayed name changes. The folder, customers and conversations stay where they are.</p></div><button type="button" className="icon-button" disabled={busy} aria-label="Close" onClick={onClose}>×</button></header>
      <label><span>Name</span><input autoFocus maxLength={120} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
      <small>{project.cwd}</small>
      {error && <p className="automation-form-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="new-task-submit" disabled={busy || !name.trim() || name.trim().length > 120}>{busy ? "Saving…" : "Save name"}</button></footer>
    </form>
  </div>;
}
