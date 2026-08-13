import { useEffect, useMemo, useState } from "react";
import type { Automation, CreateAutomationInput } from "@codex-board/protocol";
import { createAutomation, deleteAutomation, listAutomations, setAutomationEnabled } from "./api";
import type { BoardThread } from "./types";

type Kind = "recurringMessage" | "scheduledMessage" | "calendarMessage" | "categoryPipeline";
const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]] as const;

function automationCopy(automation: Automation, names: Map<string, string>): string {
  const action = automation.action;
  if (action.kind === "recurringMessage") return `Every ${action.everyMinutes} min · ${names.get(action.threadId) || "Task"}`;
  if (action.kind === "scheduledMessage") return `Once · ${new Date(action.runAt).toLocaleString()}`;
  if (action.kind === "calendarMessage") return `${action.weekdays.length === 7 ? "Every day" : action.weekdays.map((day) => DAYS.find(([value]) => value === day)?.[1]).join(", ")} · ${String(Math.floor(action.minuteOfDay / 60)).padStart(2, "0")}:${String(action.minuteOfDay % 60).padStart(2, "0")}`;
  return `${action.fromCategory} → ${action.toCategory} after ${action.afterMinutes} min`;
}

export function AutomationsDialog({ threads, categories, onClose }: { threads: BoardThread[]; categories: string[]; onClose: () => void }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [kind, setKind] = useState<Kind>("recurringMessage");
  const [name, setName] = useState("");
  const [threadId, setThreadId] = useState(threads[0]?.id || "");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [runAt, setRunAt] = useState("");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
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
    const [hour, minute] = time.split(":").map(Number);
    let input: CreateAutomationInput;
    if (kind === "recurringMessage") input = { name, action: { kind, threadId, prompt, everyMinutes: interval, startInMinutes: interval } };
    else if (kind === "scheduledMessage") input = { name, action: { kind, threadId, prompt, runAt: new Date(runAt).getTime() } };
    else if (kind === "calendarMessage") input = { name, action: { kind, threadId, prompt, weekdays, minuteOfDay: hour * 60 + minute, timezoneOffsetMinutes: new Date().getTimezoneOffset() } };
    else input = { name, action: { kind, fromCategory, toCategory, afterMinutes: interval } };
    setBusy(true); setError(null);
    try { await createAutomation(input); setName(""); setPrompt(""); refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const messageKind = kind !== "categoryPipeline";
  const validSchedule = kind === "scheduledMessage" ? new Date(runAt).getTime() > Date.now() : kind !== "calendarMessage" || weekdays.length > 0;
  const valid = name.trim() && validSchedule && (messageKind ? threadId && prompt.trim() : Number(minutes) >= 1 && fromCategory && toCategory && fromCategory !== toCategory) && (kind !== "recurringMessage" || Number(minutes) >= 1);

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="automations-dialog" role="dialog" aria-modal="true" aria-label="Automations">
    <header><div><span className="eyebrow">Workflows</span><h2>Automations</h2><p>Schedules run locally on this PC, even when mobile is closed.</p></div><button className="icon-button" onClick={onClose}>×</button></header>
    <div className="automations-layout"><form className="automation-form" onSubmit={(event) => void submit(event)}>
      <div className="automation-tabs automation-tabs-four"><button type="button" className={kind === "recurringMessage" ? "active" : ""} onClick={() => setKind("recurringMessage")}>Interval</button><button type="button" className={kind === "scheduledMessage" ? "active" : ""} onClick={() => setKind("scheduledMessage")}>Once</button><button type="button" className={kind === "calendarMessage" ? "active" : ""} onClick={() => setKind("calendarMessage")}>Calendar</button><button type="button" className={kind === "categoryPipeline" ? "active" : ""} onClick={() => setKind("categoryPipeline")}>Pipeline</button></div>
      <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily project check" /></label>
      {messageKind ? <><label><span>Task</span><select value={threadId} onChange={(event) => setThreadId(event.target.value)}>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.displayTitle}</option>)}</select></label><label><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Review progress and continue the next useful step" /></label></> : <div className="pipeline-fields"><label><span>From</span><select value={fromCategory} onChange={(event) => setFromCategory(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><b>→</b><label><span>To</span><select value={toCategory} onChange={(event) => setToCategory(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label></div>}
      {kind === "recurringMessage" && <label><span>Repeat every</span><div className="number-field"><input type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><small>minutes</small></div></label>}
      {kind === "scheduledMessage" && <label><span>Run once</span><input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></label>}
      {kind === "calendarMessage" && <><label><span>Time</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label><div className="weekday-picker">{DAYS.map(([day, label]) => <button type="button" key={day} className={weekdays.includes(day) ? "active" : ""} onClick={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day])}>{label}</button>)}</div></>}
      {kind === "categoryPipeline" && <label><span>Move after</span><div className="number-field"><input type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><small>minutes in category</small></div></label>}
      {error && <p className="automation-form-error">{error}</p>}<button className="automation-submit" disabled={busy || !valid}>{busy ? "Creating…" : "Create automation"}</button>
    </form><div className="automation-list"><div className="automation-list-heading"><strong>Workflows</strong><span>{items.length}</span></div>{items.length === 0 && <div className="automation-empty">No automations yet.</div>}{items.map((automation) => <article className="automation-item" key={automation.id}><span className="automation-kind">{automation.action.kind === "categoryPipeline" ? "→" : automation.action.kind === "scheduledMessage" ? "◷" : "↻"}</span><div><strong>{automation.name}</strong><p>{automationCopy(automation, threadNames)}</p>{automation.lastError && <small>{automation.lastError}</small>}</div><button className={automation.enabled ? "automation-toggle on" : "automation-toggle"} onClick={() => void setAutomationEnabled(automation.id, !automation.enabled).then(refresh)}><i /></button><button className="automation-delete" onClick={() => void deleteAutomation(automation.id).then(refresh)}>Delete</button></article>)}</div></div>
  </section></div>;
}
