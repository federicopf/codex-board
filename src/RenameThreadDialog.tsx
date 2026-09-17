import { useState } from "react";
import { asCodexError } from "./api";
import type { BoardThread } from "./types";

export function RenameThreadDialog({ thread, onClose, onRename }: { thread: BoardThread; onClose: () => void; onRename: (title: string) => Promise<void> }) {
  const [title, setTitle] = useState(thread.displayTitle);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!title.trim() || busy) return;
    setBusy(true); setError(null);
    try { await onRename(title.trim()); onClose(); }
    catch (cause) { setError(asCodexError(cause).message); }
    finally { setBusy(false); }
  }
  return <div className="dialog-backdrop fork-backdrop" onMouseDown={(event)=>{if(event.target===event.currentTarget&&!busy)onClose()}}>
    <form className="new-task-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-thread-title" onSubmit={(event)=>void submit(event)}>
      <header><div><span className="eyebrow">Task details</span><h2 id="rename-thread-title">Rename conversation</h2><p>Only the title changes. Category, project and history stay the same.</p></div><button type="button" className="icon-button" disabled={busy} aria-label="Close" onClick={onClose}>×</button></header>
      <label><span>Title</span><input autoFocus value={title} disabled={busy} onChange={(event)=>setTitle(event.target.value)}/></label>
      {error&&<p className="automation-form-error" role="alert">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="new-task-submit" disabled={busy||!title.trim()}>{busy?"Saving…":"Save title"}</button></footer>
    </form>
  </div>;
}
