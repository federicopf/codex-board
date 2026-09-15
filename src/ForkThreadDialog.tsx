import { useEffect, useState } from "react";
import { asCodexError, loadThread } from "./api";
import { visibleUserMessage } from "./lib/chat";
import type { BoardThread, JsonValue } from "./types";

type JsonObject = Record<string, JsonValue>;
const object = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const string = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";

function itemText(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(itemText).filter(Boolean).join(" ");
  const item = object(value);
  return string(item.text) || string(item.content) || string(item.value);
}

export interface ForkTurnChoice { id: string; label: string; }

export function forkTurnChoices(turns: JsonValue[] | undefined): ForkTurnChoice[] {
  if (!turns) return [];
  return turns.flatMap((rawTurn, index) => {
    const turn = object(rawTurn);
    const id = string(turn.id);
    if (!id || string(turn.status) === "inProgress") return [];
    const items = Array.isArray(turn.items) ? turn.items : [];
    const userItem = items.map(object).find((item) => string(item.type) === "userMessage");
    const prompt = visibleUserMessage(itemText(userItem?.content)).replace(/\s+/g, " ").trim();
    return [{ id, label: `Turn ${index + 1}${prompt ? ` · ${prompt.slice(0, 74)}` : ""}` }];
  });
}

export function ForkThreadDialog({ thread, categories, busy, onClose, onFork }: {
  thread: BoardThread;
  categories: string[];
  busy: boolean;
  onClose: () => void;
  onFork: (category: string, title: string, lastTurnId: string | null) => Promise<void>;
}) {
  const [category, setCategory] = useState(thread.category);
  const [title, setTitle] = useState(`${thread.displayTitle || "Untitled task"} (fork)`);
  const [lastTurnId, setLastTurnId] = useState("");
  const [turns, setTurns] = useState<ForkTurnChoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void loadThread(thread.id)
      .then((loaded) => { if (!cancelled) setTurns(forkTurnChoices(loaded.turns)); })
      .catch((cause) => { if (!cancelled) setError(asCodexError(cause).message); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [thread.id]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    try { await onFork(category, title.trim(), lastTurnId || null); }
    catch (cause) { setError(asCodexError(cause).message); }
  }

  return <div className="dialog-backdrop fork-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <form className="new-task-dialog fork-dialog" onSubmit={(event) => void submit(event)}>
      <header><div><span className="eyebrow">Branch conversation</span><h2>Fork this task</h2><p>Create an independent Codex conversation with the selected history.</p></div><button type="button" className="icon-button" disabled={busy} onClick={onClose} aria-label="Close">×</button></header>
      <div className="fork-source"><strong>{thread.displayTitle}</strong><small>{thread.cwd || "Local Codex project"}</small></div>
      <div className="new-task-grid">
        <label><span>Category</span><select value={category} onChange={(event) => setCategory(event.target.value)}>{categories.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label><span>History</span><select value={lastTurnId} disabled={loading} onChange={(event) => setLastTurnId(event.target.value)}><option value="">Entire conversation</option>{turns.map((turn) => <option key={turn.id} value={turn.id}>{turn.label}</option>)}</select></label>
      </div>
      <label><span>New task title</span><input value={title} onChange={(event) => setTitle(event.target.value)} autoFocus /></label>
      <p className="fork-note">The new task keeps this project and becomes fully independent. Later messages do not affect the original.</p>
      {error && <p className="automation-form-error">{error}</p>}
      <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="new-task-submit" disabled={busy || loading || !title.trim()}>{busy ? "Forking…" : "Fork and open"}</button></footer>
    </form>
  </div>;
}
