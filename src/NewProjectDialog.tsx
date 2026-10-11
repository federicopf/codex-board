import { useState } from "react";

export function NewProjectDialog({ existingPaths, onClose, onCreate }: {
  existingPaths: string[];
  onClose: () => void;
  onCreate: (cwd: string) => void;
}) {
  const [cwd, setCwd] = useState("");
  const normalized = cwd.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
  const duplicate = existingPaths.some((path) => path.trim().replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase() === normalized);

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="new-task-dialog" onSubmit={(event) => { event.preventDefault(); if (normalized && !duplicate) onCreate(cwd.trim()); }}>
      <header><div><span className="eyebrow">Project boards</span><h2>Create a project</h2><p>Register a working folder on this PC. The board remains available even when it has no conversations.</p></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button></header>
      <label><span>Working folder</span><input autoFocus value={cwd} onChange={(event) => setCwd(event.target.value)} placeholder="C:\\Users\\you\\Projects\\my-project" /></label>
      {duplicate && <p className="automation-form-error">This project already exists.</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button className="new-task-submit" disabled={!normalized || duplicate}>Create project</button></footer>
    </form>
  </div>;
}
