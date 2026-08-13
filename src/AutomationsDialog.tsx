import { useEffect, useMemo, useState } from "react";
import type { Automation, CreateAutomationInput } from "@codex-board/protocol";
import { createAutomation, deleteAutomation, listAutomations, setAutomationEnabled } from "./api";
import type { BoardThread } from "./types";

export function AutomationsDialog({ threads, categories, onClose }: { threads: BoardThread[]; categories: string[]; onClose: () => void }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [kind, setKind] = useState<"recurringMessage" | "categoryPipeline">("recurringMessage");
  const [name, setName] = useState("");
  const [threadId, setThreadId] = useState(threads[0]?.id || "");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [fromCategory, setFromCategory] = useState(categories[0] || "");
  const [toCategory, setToCategory] = useState(categories[1] || categories[0] || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadNames = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.displayTitle])), [threads]);
  const refresh = () => void listAutomations().then(setItems).catch((cause) => setError(String(cause)));
  useEffect(refresh, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const interval = Number.parseInt(minutes, 10);
    const input: CreateAutomationInput = kind === "recurringMessage"
      ? { name, action: { kind, threadId, prompt, everyMinutes: interval, startInMinutes: interval } }
      : { name, action: { kind, fromCategory, toCategory, afterMinutes: interval } };
    setBusy(true); setError(null);
    try { await createAutomation(input); setName(""); setPrompt(""); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="automations-dialog" role="dialog" aria-modal="true" aria-label="Automations">
    <header><div><span className="eyebrow">Workflows</span><h2>Automations</h2><p>Recurring Codex tasks and timed category pipelines run locally on this PC.</p></div><button className="icon-button" onClick={onClose}>×</button></header>
    <div className="automations-layout"><form className="automation-form" onSubmit={(event) => void submit(event)}>
      <div className="automation-tabs"><button type="button" className={kind === "recurringMessage" ? "active" : ""} onClick={() => setKind("recurringMessage")}>Recurring task</button><button type="button" className={kind === "categoryPipeline" ? "active" : ""} onClick={() => setKind("categoryPipeline")}>Pipeline move</button></div>
      <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily project check" /></label>
      {kind === "recurringMessage" ? <><label><span>Task</span><select value={threadId} onChange={(event) => setThreadId(event.target.value)}>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.displayTitle}</option>)}</select></label><label><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Review progress and continue the next useful step" /></label><label><span>Repeat every</span><div className="number-field"><input type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><small>minutes</small></div></label></> : <><div className="pipeline-fields"><label><span>From</span><select value={fromCategory} onChange={(event) => setFromCategory(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><b>→</b><label><span>To</span><select value={toCategory} onChange={(event) => setToCategory(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label></div><label><span>Move after</span><div className="number-field"><input type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><small>minutes in category</small></div></label></>}
      {error && <p className="automation-form-error">{error}</p>}<button className="automation-submit" disabled={busy || !name.trim() || Number(minutes) < 1 || (kind === "recurringMessage" ? !threadId || !prompt.trim() : !fromCategory || !toCategory || fromCategory === toCategory)}>{busy ? "Creating…" : "Create automation"}</button>
    </form><div className="automation-list"><div className="automation-list-heading"><strong>Active workflows</strong><span>{items.length}</span></div>{items.length === 0 && <div className="automation-empty">No automations yet.</div>}{items.map((automation) => <article className="automation-item" key={automation.id}><span className="automation-kind">{automation.action.kind === "recurringMessage" ? "↻" : "→"}</span><div><strong>{automation.name}</strong><p>{automation.action.kind === "recurringMessage" ? `Every ${automation.action.everyMinutes} min · ${threadNames.get(automation.action.threadId) || "Task"}` : `${automation.action.fromCategory} → ${automation.action.toCategory} after ${automation.action.afterMinutes} min`}</p>{automation.lastError && <small>{automation.lastError}</small>}</div><button className={automation.enabled ? "automation-toggle on" : "automation-toggle"} onClick={() => void setAutomationEnabled(automation.id, !automation.enabled).then(refresh)}><i /></button><button className="automation-delete" onClick={() => void deleteAutomation(automation.id).then(refresh)}>Delete</button></article>)}</div></div>
  </section></div>;
}
