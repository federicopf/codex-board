import { useEffect, useMemo, useState } from "react";
import type { Automation, CreateAutomationInput } from "@codex-board/protocol";
import { createAutomation, deleteAutomation, listAutomations, setAutomationEnabled } from "./api";
import type { BoardThread } from "./types";

type Kind = "recurringMessage" | "scheduledMessage" | "calendarMessage";
type DialogView = "overview" | "createAutomation" | "createPipeline";
const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]] as const;
const ALL_PROJECTS = "__all__";
const BOARD_WIDE = "__board__";

type AutomationGroup = { key: string; label: string; automations: Automation[] };
type PipelineAction = Extract<Automation["action"], { kind: "categoryPipeline" } | { kind: "scheduledCategoryPipeline" }>;

function automationCopy(automation: Automation, names: Map<string, string>): string {
  const action = automation.action;
  if (action.kind === "recurringMessage") return `Every ${action.everyMinutes} min · ${names.get(action.threadId) || "Task"}`;
  if (action.kind === "scheduledMessage") return `Once · ${new Date(action.runAt).toLocaleString()}`;
  if (action.kind === "calendarMessage") return `${action.weekdays.length === 7 ? "Every day" : action.weekdays.map((day) => DAYS.find(([value]) => value === day)?.[1]).join(", ")} · ${String(Math.floor(action.minuteOfDay / 60)).padStart(2, "0")}:${String(action.minuteOfDay % 60).padStart(2, "0")}`;
  if (action.kind === "categoryPipeline") return `${action.fromCategory} → ${action.toCategory} after ${action.afterMinutes} min`;
  return `${action.fromCategory} → ${action.toCategory} · ${new Date(action.runAt).toLocaleString()}`;
}

function isPipelineAction(action: Automation["action"]): action is PipelineAction {
  return action.kind === "categoryPipeline" || action.kind === "scheduledCategoryPipeline";
}

function isPipeline(automation: Automation): boolean {
  return isPipelineAction(automation.action);
}

function automationNextRun(automation: Automation): number | null {
  const action = automation.action;
  if (action.kind === "scheduledMessage" || action.kind === "scheduledCategoryPipeline") return action.runAt;
  if (action.kind === "recurringMessage" || action.kind === "calendarMessage") return action.nextRunAt;
  return null;
}

function nextRunCopy(automation: Automation): string {
  const nextRun = automationNextRun(automation);
  if (!automation.enabled) return "Paused";
  if (nextRun === null) return "Continuously active";
  return `Next · ${new Date(nextRun).toLocaleString([], { weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}`;
}

export function AutomationsDialog({ threads, categories, onClose }: { threads: BoardThread[]; categories: string[]; onClose: () => void }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [view, setView] = useState<DialogView>("overview");
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
  const [pipelineTiming, setPipelineTiming] = useState<"delay" | "scheduled">("delay");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);
  const threadNames = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.displayTitle])), [threads]);
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const groups = useMemo<AutomationGroup[]>(() => {
    const grouped = new Map<string, AutomationGroup>();
    for (const automation of items) {
      const action = automation.action;
      const pipeline = isPipelineAction(action);
      const thread = pipeline ? null : threadsById.get(action.threadId);
      const key = pipeline ? BOARD_WIDE : thread?.projectKey || "__unknown__";
      const label = pipeline ? "Board-wide pipelines" : thread?.projectLabel || "Unavailable project";
      if (projectFilter !== ALL_PROJECTS && projectFilter !== key) continue;
      const group = grouped.get(key) || { key, label, automations: [] };
      group.automations.push(automation);
      grouped.set(key, group);
    }
    return [...grouped.values()]
      .sort((left, right) => left.key === BOARD_WIDE ? 1 : right.key === BOARD_WIDE ? -1 : left.label.localeCompare(right.label))
      .map((group) => ({ ...group, automations: group.automations.sort((left, right) => {
        if (left.enabled !== right.enabled) return left.enabled ? -1 : 1;
        return (automationNextRun(left) ?? Number.MAX_SAFE_INTEGER) - (automationNextRun(right) ?? Number.MAX_SAFE_INTEGER) || left.name.localeCompare(right.name);
      }) }));
  }, [items, projectFilter, threadsById]);
  const projectOptions = useMemo(() => {
    const options = new Map<string, string>();
    for (const automation of items) {
      if (isPipelineAction(automation.action)) options.set(BOARD_WIDE, "Board-wide pipelines");
      else {
        const thread = threadsById.get(automation.action.threadId);
        options.set(thread?.projectKey || "__unknown__", thread?.projectLabel || "Unavailable project");
      }
    }
    return [...options].sort((left, right) => left[1].localeCompare(right[1]));
  }, [items, threadsById]);
  const activeCount = items.filter((automation) => automation.enabled).length;
  const nextDayCount = items.filter((automation) => {
    const nextRun = automationNextRun(automation);
    return automation.enabled && nextRun !== null && nextRun >= Date.now() && nextRun <= Date.now() + 86_400_000;
  }).length;
  const refresh = () => void listAutomations().then(setItems).catch((cause) => setError(String(cause)));
  useEffect(refresh, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const interval = Number.parseInt(minutes, 10);
    const [hour, minute] = time.split(":").map(Number);
    let input: CreateAutomationInput;
    if (view === "createPipeline") input = pipelineTiming === "delay"
      ? { name, action: { kind: "categoryPipeline", fromCategory, toCategory, afterMinutes: interval } }
      : { name, action: { kind: "scheduledCategoryPipeline", fromCategory, toCategory, runAt: new Date(runAt).getTime() } };
    else if (kind === "recurringMessage") input = { name, action: { kind, threadId, prompt, everyMinutes: interval, startInMinutes: interval } };
    else if (kind === "scheduledMessage") input = { name, action: { kind, threadId, prompt, runAt: new Date(runAt).getTime() } };
    else input = { name, action: { kind, threadId, prompt, weekdays, minuteOfDay: hour * 60 + minute, timezoneOffsetMinutes: new Date().getTimezoneOffset() } };
    setBusy(true); setError(null);
    try { await createAutomation(input); setName(""); setPrompt(""); refresh(); setView("overview"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const creatingPipeline = view === "createPipeline";
  const validSchedule = creatingPipeline
    ? pipelineTiming === "delay" ? Number(minutes) >= 1 : new Date(runAt).getTime() > Date.now()
    : kind === "scheduledMessage" ? new Date(runAt).getTime() > Date.now() : kind !== "calendarMessage" || weekdays.length > 0;
  const valid = name.trim() && validSchedule && (creatingPipeline
    ? fromCategory && toCategory && fromCategory !== toCategory
    : threadId && prompt.trim() && (kind !== "recurringMessage" || Number(minutes) >= 1));

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="automations-dialog" role="dialog" aria-modal="true" aria-label="Automations">
    <header><div>{view !== "overview" && <button className="automation-back" onClick={() => setView("overview")}>← All workflows</button>}<span className="eyebrow">Workflows</span><h2>{view === "overview" ? "Automations & pipelines" : creatingPipeline ? "New pipeline" : "New automation"}</h2><p>{view === "overview" ? "Review schedules by project and coordinate upcoming work." : creatingPipeline ? "Move tasks between categories after a delay or at a specific date." : "Schedule a prompt for a Codex task."}</p></div><button className="icon-button" onClick={onClose}>×</button></header>
    {view !== "overview" ? <form className="automation-form automation-create-view" onSubmit={(event) => void submit(event)}>
      {creatingPipeline ? <div className="automation-tabs"><button type="button" className={pipelineTiming === "delay" ? "active" : ""} onClick={() => setPipelineTiming("delay")}>After time</button><button type="button" className={pipelineTiming === "scheduled" ? "active" : ""} onClick={() => setPipelineTiming("scheduled")}>Specific date</button></div> : <div className="automation-tabs automation-tabs-three"><button type="button" className={kind === "recurringMessage" ? "active" : ""} onClick={() => setKind("recurringMessage")}>Interval</button><button type="button" className={kind === "scheduledMessage" ? "active" : ""} onClick={() => setKind("scheduledMessage")}>Once</button><button type="button" className={kind === "calendarMessage" ? "active" : ""} onClick={() => setKind("calendarMessage")}>Calendar</button></div>}
      <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily project check" /></label>
      {!creatingPipeline ? <><label><span>Task</span><select value={threadId} onChange={(event) => setThreadId(event.target.value)}>{threads.map((thread) => <option key={thread.id} value={thread.id}>{thread.displayTitle}</option>)}</select></label><label><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Review progress and continue the next useful step" /></label></> : <div className="pipeline-fields"><label><span>From</span><select value={fromCategory} onChange={(event) => setFromCategory(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label><b>→</b><label><span>To</span><select value={toCategory} onChange={(event) => setToCategory(event.target.value)}>{categories.map((category) => <option key={category}>{category}</option>)}</select></label></div>}
      {!creatingPipeline && kind === "recurringMessage" && <label><span>Repeat every</span><div className="number-field"><input type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><small>minutes</small></div></label>}
      {!creatingPipeline && kind === "scheduledMessage" && <label><span>Run once</span><input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></label>}
      {!creatingPipeline && kind === "calendarMessage" && <><label><span>Time</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label><div className="weekday-picker">{DAYS.map(([day, label]) => <button type="button" key={day} className={weekdays.includes(day) ? "active" : ""} onClick={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day])}>{label}</button>)}</div></>}
      {creatingPipeline && pipelineTiming === "delay" && <label><span>Move after</span><div className="number-field"><input type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><small>minutes in category</small></div></label>}
      {creatingPipeline && pipelineTiming === "scheduled" && <label><span>Move on</span><input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></label>}
      {error && <p className="automation-form-error">{error}</p>}<div className="automation-create-actions"><button type="button" className="secondary" onClick={() => setView("overview")}>Cancel</button><button className="automation-submit" disabled={busy || !valid}>{busy ? "Creating…" : creatingPipeline ? "Create pipeline" : "Create automation"}</button></div>
    </form> : <div className="automation-list automation-overview">
      <div className="automation-list-heading"><div><span className="eyebrow">Orchestration</span><strong>Automation schedule</strong></div><div className="automation-list-actions"><select aria-label="Filter automations by project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value={ALL_PROJECTS}>All projects</option>{projectOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className="automation-new" onClick={() => setView("createAutomation")}>+ Automation</button><button className="pipeline-new" onClick={() => setView("createPipeline")}>→ Pipeline</button></div></div>
      <div className="automation-stats"><div><strong>{items.length}</strong><span>Total</span></div><div><strong>{activeCount}</strong><span>Active</span></div><div><strong>{nextDayCount}</strong><span>Next 24h</span></div></div>
      {items.length === 0 && <div className="automation-empty">No automations yet.</div>}
      {items.length > 0 && groups.length === 0 && <div className="automation-empty">No automations for this project.</div>}
      {groups.map((group) => <section className="automation-project-group" key={group.key}><div className="automation-project-heading"><div><span className="automation-project-mark" /> <strong>{group.label}</strong></div><span>{group.automations.length}</span></div>{group.automations.map((automation) => <article className="automation-item" key={automation.id}><span className="automation-kind">{isPipeline(automation) ? "→" : automation.action.kind === "scheduledMessage" ? "◷" : "↻"}</span><div><strong>{automation.name}</strong><p>{automationCopy(automation, threadNames)}</p><em className={automation.enabled ? "" : "paused"}>{nextRunCopy(automation)}</em>{automation.lastError && <small>{automation.lastError}</small>}</div><button aria-label={automation.enabled ? `Pause ${automation.name}` : `Resume ${automation.name}`} className={automation.enabled ? "automation-toggle on" : "automation-toggle"} onClick={() => void setAutomationEnabled(automation.id, !automation.enabled).then(refresh)}><i /></button><button className="automation-delete" onClick={() => void deleteAutomation(automation.id).then(refresh)}>Delete</button></article>)}</section>)}
    </div>}
  </section></div>;
}
