import { useState } from "react";
import { projectSetupPreview, type CreateProjectInput } from "@codex-board/protocol";
import { sameProjectPath } from "./lib/projects";

export function NewProjectDialog({ existingPaths, onClose, onCreate }: {
  existingPaths: string[];
  onClose: () => void;
  onCreate: (input: CreateProjectInput, openChat: boolean) => Promise<void>;
}) {
  const [kind, setKind] = useState<CreateProjectInput["kind"]>("windows");
  const [path, setPath] = useState("");
  const [distribution, setDistribution] = useState("Debian");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = { kind, path, distribution };
  const preview = projectSetupPreview(input);
  const duplicate = Boolean(preview.cwd) && existingPaths.some((existing) => sameProjectPath(existing, preview.cwd));

  async function create(openChat: boolean) {
    if (preview.error || duplicate || busy) return;
    setBusy(true); setError(null);
    try { await onCreate(input, openChat); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="new-task-dialog" onSubmit={(event) => { event.preventDefault(); void create(false); }}>
      <header><div><span className="eyebrow">Project boards</span><h2>Create a project</h2><p>The folder is created on the connected PC. You can start a chat in it immediately.</p></div><button type="button" className="icon-button" aria-label="Close" disabled={busy} onClick={onClose}>×</button></header>
      <label><span>Location</span><select value={kind} onChange={(event) => { setKind(event.target.value as CreateProjectInput["kind"]); setPath(""); setError(null); }}><option value="windows">Windows</option><option value="wsl">WSL · /var/www/</option></select></label>
      {kind === "wsl" && <label><span>WSL distribution</span><input value={distribution} onChange={(event) => setDistribution(event.target.value)} placeholder="Debian" autoComplete="off" /></label>}
      <label><span>{kind === "wsl" ? "Folder under /var/www/" : "Windows folder"}</span><input autoFocus value={path} onChange={(event) => setPath(event.target.value)} placeholder={kind === "wsl" ? "personal-projects/tkss-valencia" : "C:\\Users\\you\\Projects\\my-project"} autoComplete="off" /></label>
      {preview.cwd && <p className="new-project-preview">{preview.cwd}</p>}
      {path.trim() && preview.error && <p className="automation-form-error">{preview.error}</p>}
      {duplicate && <p className="automation-form-error">This project already exists.</p>}
      {error && <p className="automation-form-error">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" disabled={busy || Boolean(preview.error) || duplicate}>Create project</button><button type="button" className="new-task-submit" disabled={busy || Boolean(preview.error) || duplicate} onClick={() => void create(true)}>{busy ? "Creating…" : "Create and start chat"}</button></footer>
    </form>
  </div>;
}
