import { useMemo, useState } from "react";
import type { BoardThread } from "./types";

export function NewTaskDialog({ threads, categories, defaultProjectKey, onClose, onCreate }: { threads: BoardThread[]; categories: string[]; defaultProjectKey?: string; onClose: () => void; onCreate: (cwd: string, category: string, title: string, prompt: string) => Promise<void> }) {
  const projects = useMemo(() => [...new Map(threads.filter((thread) => thread.cwd).map((thread) => [thread.projectKey, { key: thread.projectKey, cwd: thread.cwd!, label: thread.projectLabel }])).values()], [threads]);
  const [cwd, setCwd] = useState(projects.find((item) => item.key === defaultProjectKey)?.cwd || projects[0]?.cwd || "");
  const [category, setCategory] = useState(categories[0] || "Uncategorized");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true); setError(null);
    try { await onCreate(cwd, category, title.trim(), prompt.trim()); onClose(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="new-task-dialog" onSubmit={(event) => void submit(event)}>
    <header><div><span className="eyebrow">New work</span><h2>Create a Codex task</h2><p>Start a real Codex thread and place it on the board immediately.</p></div><button type="button" className="icon-button" onClick={onClose}>×</button></header>
    <div className="new-task-grid"><label><span>Project</span><select value={cwd} onChange={(event) => setCwd(event.target.value)}>{projects.map((project) => <option key={project.cwd} value={project.cwd}>{project.label}</option>)}</select></label><label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label></div>
    <label><span>Task title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Implement onboarding" autoFocus /></label><label><span>First message</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Describe what Codex should do…" /></label>
    {error && <p className="automation-form-error">{error}</p>}<footer><button type="button" onClick={onClose}>Cancel</button><button className="new-task-submit" disabled={busy || !cwd || !title.trim() || !prompt.trim()}>{busy ? "Creating…" : "Create and start"}</button></footer>
  </form></div>;
}
