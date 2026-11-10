import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { asCodexError, getModels } from "./api";
import type { ProjectInfo } from "./lib/projects";
import type { BoardThread } from "./types";
import { Icon } from "./ui/Icon";

interface ImageAttachmentDraft { id: string; name: string; dataUrl: string; }

export function NewTaskDialog({ threads, projects, categories, defaultProjectKey, defaultModel = "", onClose, onCreate }: { threads: BoardThread[]; projects: ProjectInfo[]; categories: string[]; defaultProjectKey?: string; defaultModel?: string; onClose: () => void; onCreate: (cwd: string, category: string, title: string, prompt: string, imageUrls: string[], model: string) => Promise<void> }) {
  const [cwd, setCwd] = useState(projects.find((item) => item.key === defaultProjectKey)?.cwd || projects[0]?.cwd || "");
  const [category, setCategory] = useState(categories[0] || "Uncategorized");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState(defaultModel);
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelError, setModelError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ImageAttachmentDraft[]>([]);
  const [readingFiles, setReadingFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void getModels().then((value) => {
      if (!alive) return;
      const data = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).data : null;
      if (!Array.isArray(data)) throw new Error("Model catalog unavailable");
      setModels(data.map((item) => {
        const row = item as Record<string, unknown>;
        return { id: typeof row.model === "string" ? row.model : String(row.id || ""), name: typeof row.displayName === "string" ? row.displayName : String(row.model || row.id || "") };
      }).filter((item) => item.id));
    }).catch((cause) => { if (alive) setModelError(asCodexError(cause).message); });
    return () => { alive = false; };
  }, []);

  function readFile(file: File): Promise<ImageAttachmentDraft> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => typeof reader.result === "string" ? resolve({ id: crypto.randomUUID(), name: file.name, dataUrl: reader.result }) : reject(new Error(`Could not read ${file.name}`));
      reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
      reader.readAsDataURL(file);
    });
  }

  function selectFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    setReadingFiles(true); setError(null);
    void Promise.all(files.map(readFile))
      .then((selected) => setAttachments((current) => [...current, ...selected]))
      .catch((cause) => setError(asCodexError(cause).message))
      .finally(() => setReadingFiles(false));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError(null);
    if (!model) { setError("Choose a model before starting this chat."); return; }
    const normalizedTitle = title.trim().toLocaleLowerCase();
    const duplicate = threads.some((thread) => thread.cwd === cwd && thread.displayTitle.trim().toLocaleLowerCase() === normalizedTitle);
    if (duplicate) {
      setError("A task with this title already exists in the selected project.");
      return;
    }
    setBusy(true);
    try { await onCreate(cwd, category, title.trim(), prompt.trim(), attachments.map((attachment) => attachment.dataUrl), model); onClose(); }
    catch (cause) { setError(asCodexError(cause).message); }
    finally { setBusy(false); }
  }

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><form className="new-task-dialog" onSubmit={(event) => void submit(event)}>
    <header><div><span className="eyebrow">New work</span><h2>Create a Codex task</h2><p>Start a real Codex thread and place it on the board immediately.</p></div><button type="button" className="icon-button" onClick={onClose}>×</button></header>
    <div className="new-task-grid"><label><span>Project</span><select value={cwd} onChange={(event) => setCwd(event.target.value)}>{projects.map((project) => <option key={project.cwd} value={project.cwd}>{project.label}</option>)}</select></label><label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label></div>
    <label><span>Model for this chat</span><select value={model} onChange={(event) => setModel(event.target.value)} required><option value="">Choose a model</option>{model && !models.some((item) => item.id === model) && <option value={model}>{model}</option>}{models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {modelError && <p className="automation-form-error">Could not load model list: {modelError}</p>}
    <label><span>Task title</span><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Implement onboarding" autoFocus /></label><label><span>First message</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); if (!busy && cwd && title.trim() && prompt.trim() && model) void submit(event as unknown as React.FormEvent); } }} placeholder="Describe what Codex should do…" /></label>
    <div className="new-task-attachments"><input ref={fileInputRef} hidden type="file" accept="image/*" multiple onChange={selectFiles} /><button type="button" className="new-task-attach" disabled={busy || readingFiles} onClick={() => fileInputRef.current?.click()}><Icon name="paperclip" />{readingFiles ? "Reading images…" : "Attach images"}</button><small>Images are sent together with the first message.</small></div>
    {attachments.length > 0 && <div className="composer-attachments new-task-attachment-list">{attachments.map((attachment) => <div className="composer-attachment" key={attachment.id}><img src={attachment.dataUrl} alt="" /><span title={attachment.name}>{attachment.name}</span><button type="button" aria-label={`Remove ${attachment.name}`} onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}>×</button></div>)}</div>}
    {error && <p className="automation-form-error">{error}</p>}<footer><button type="button" onClick={onClose}>Cancel</button><button className="new-task-submit" disabled={busy || readingFiles || !cwd || !title.trim() || !prompt.trim() || !model}>{busy ? "Creating…" : "Create and start"}</button></footer>
  </form></div>;
}
