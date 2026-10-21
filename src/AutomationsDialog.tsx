import { useEffect, useMemo, useState } from "react";
import { automationOutcome, automationEditFields, automationUpdateInput, automationDateTimeValue, automationIntervalMinutes, formatAutomationInterval } from "@codex-board/protocol";
import type { Automation, AutomationIntervalUnit, CreateAutomationInput } from "@codex-board/protocol";
import { createAutomation, deleteAutomation, listAutomations, retryAutomation, setAutomationEnabled, updateAutomation } from "./api";
import type { BoardThread } from "./types";
import { Icon } from "./ui/Icon";
import { RetryAutomationButton } from "./RetryAutomationButton";

type Kind = "recurringMessage" | "scheduledMessage" | "calendarMessage";
type DialogView = "overview" | "createAutomation" | "createPipeline";
const DAYS = [[1, "Mon"], [2, "Tue"], [3, "Wed"], [4, "Thu"], [5, "Fri"], [6, "Sat"], [0, "Sun"]] as const;
const ALL_PROJECTS = "__all__";
const BOARD_WIDE = "__board__";

type AutomationGroup = { key: string; label: string; automations: Automation[] };
type PipelineAction = Extract<Automation["action"], { kind: "categoryPipeline" } | { kind: "scheduledCategoryPipeline" }>;

function ScheduleTaskPicker({ tasks, selectedId, onSelect }: { tasks: BoardThread[]; selectedId: string; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  const selected = tasks.find((task) => task.id === selectedId);
  return <div className="automation-task-picker"><span className="automation-task-picker-label">Schedule tasks · {tasks.length}</span>
    <button type="button" className="automation-task-select" onClick={() => setOpen(true)}>{selected?.displayTitle || "Choose a Schedule task"}<span>⌄</span></button>
    {open && <div className="dialog-backdrop automation-task-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}><section className="automations-dialog" role="dialog" aria-modal="true" aria-label="Choose a Schedule task"><header><div><span className="eyebrow">Schedule</span><h2>Choose a task</h2></div><button className="icon-button" aria-label="Close" onClick={() => setOpen(false)}>×</button></header><div className="automation-task-grid">{tasks.map((task) => <button type="button" key={task.id} className={`automation-task-option${selectedId === task.id ? " selected" : ""}`} aria-pressed={selectedId === task.id} onClick={() => { onSelect(task.id); setOpen(false); }}><strong>{task.displayTitle}</strong><small>{task.projectLabel} · Updated {task.updatedAt ? new Date(task.updatedAt).toLocaleDateString() : "recently"}</small></button>)}</div>{tasks.length === 0 && <p className="automation-task-empty">No tasks in Schedule.</p>}</section></div>}
  </div>;
}

function RetrySelectedAutomations({ items, onAccepted }: { items: Automation[]; onAccepted: () => void }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const retryable = items.filter((item) => item.lastResult ? automationOutcome(item.lastResult.status).retryable : Boolean(item.lastError));
  async function runSelected() {
    setBusy(true); setError(null);
    try { await Promise.all(selected.map((id) => retryAutomation(id))); setOpen(false); onAccepted(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }
  return <><button type="button" className="automation-new" disabled={!retryable.length} onClick={() => { setSelected(retryable.filter((item) => item.runState !== "running").map((item) => item.id)); setOpen(true); }}>Retry automations</button>
    {open && <div className="dialog-backdrop automation-task-modal" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setOpen(false); }}><section className="automations-dialog" role="dialog" aria-modal="true" aria-label="Retry automations"><header><div><span className="eyebrow">Manual run</span><h2>Select automations</h2><p>Choose which failed workflows to run again.</p></div><button className="icon-button" disabled={busy} onClick={() => setOpen(false)}>×</button></header><div className="automation-bulk-list">{retryable.map((item) => <label key={item.id}><input type="checkbox" disabled={item.runState === "running" || busy} checked={selected.includes(item.id)} onChange={() => setSelected((current) => current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id])}/><span>{item.name}{item.runState === "running" ? " · Running" : ""}</span></label>)}</div>{error && <p role="alert" className="automation-form-error">{error}</p>}<div className="automation-create-actions"><button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button><button className="automation-submit" disabled={busy || selected.length === 0} onClick={() => void runSelected()}>{busy ? "Queuing…" : `Retry ${selected.length} selected`}</button></div></section></div>}</>;
}

function automationCopy(automation: Automation, names: Map<string, string>): string {
  const action = automation.action;
  if (action.kind === "recurringMessage") return `Every ${formatAutomationInterval(action.everyMinutes)} · ${names.get(action.threadId) || "Task"}`;
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

export function AutomationsDialog({ threads, categories, onClose, revision = 0 }: { threads: BoardThread[]; categories: string[]; onClose: () => void; revision?: number }) {
  const [items, setItems] = useState<Automation[]>([]);
  const [editing, setEditing] = useState<Automation | null>(null);
  const [view, setView] = useState<DialogView>("overview");
  const [kind, setKind] = useState<Kind>("recurringMessage");
  const [name, setName] = useState("");
  const [threadId, setThreadId] = useState(threads.find((thread) => thread.category.toLocaleLowerCase() === "schedule")?.id || "");
  const [taskProjectKey, setTaskProjectKey] = useState(threads.find((thread) => thread.category.toLocaleLowerCase() === "schedule")?.projectKey || "");
  const [prompt, setPrompt] = useState("");
  const [minutes, setMinutes] = useState("60");
  const [intervalValue, setIntervalValue] = useState("1");
  const [intervalUnit, setIntervalUnit] = useState<AutomationIntervalUnit>("hours");
  const [runAt, setRunAt] = useState("");
  const [time, setTime] = useState("09:00");
  const [weekdays, setWeekdays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [fromCategory, setFromCategory] = useState(categories[0] || "");
  const [toCategory, setToCategory] = useState(categories[1] || categories[0] || "");
  const [pipelineTiming, setPipelineTiming] = useState<"delay" | "scheduled">("delay");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [projectFilter, setProjectFilter] = useState(ALL_PROJECTS);
  const recurringMinutes = automationIntervalMinutes(Number.parseInt(intervalValue, 10), intervalUnit);
  const threadNames = useMemo(() => new Map(threads.map((thread) => [thread.id, thread.displayTitle])), [threads]);
  const threadsById = useMemo(() => new Map(threads.map((thread) => [thread.id, thread])), [threads]);
  const scheduleThreads = useMemo(() => threads.filter((thread) => thread.category.toLocaleLowerCase() === "schedule"), [threads]);
  const taskProjects = useMemo(() => {
    const projects = new Map<string, string>();
    for (const thread of scheduleThreads) projects.set(thread.projectKey, thread.projectLabel);
    return [...projects].sort((left, right) => left[1].localeCompare(right[1]));
  }, [scheduleThreads]);
  const projectThreads = useMemo(() => scheduleThreads
    .filter((thread) => thread.projectKey === taskProjectKey)
    .sort((left, right) => (right.updatedAt ?? 0) - (left.updatedAt ?? 0)), [scheduleThreads, taskProjectKey]);
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
  useEffect(refresh, [revision]);

  function beginCreate(nextView: DialogView) {
    setEditing(null); setName(""); setPrompt(""); setRunAt(""); setError(null); setView(nextView);
  }
  function edit(automation: Automation) {
    const fields = automationEditFields(automation);
    setEditing(automation); setName(fields.name); setPrompt(fields.prompt);
    setThreadId(fields.threadId); setTaskProjectKey(threadsById.get(fields.threadId)?.projectKey || "");
    setKind(fields.kind); setIntervalValue(fields.intervalValue); setIntervalUnit(fields.intervalUnit);
    setMinutes(fields.minutes); setRunAt(fields.runAt); setTime(fields.time); setWeekdays(fields.weekdays);
    setFromCategory(fields.fromCategory); setToCategory(fields.toCategory); setPipelineTiming(fields.pipelineTiming);
    setError(null); setView(fields.pipeline ? "createPipeline" : "createAutomation");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const interval = Number.parseInt(minutes, 10);
    const [hour, minute] = time.split(":").map(Number);
    let input: CreateAutomationInput;
    if (view === "createPipeline") input = pipelineTiming === "delay"
      ? { name, action: { kind: "categoryPipeline", fromCategory, toCategory, afterMinutes: interval } }
      : { name, action: { kind: "scheduledCategoryPipeline", fromCategory, toCategory, runAt: new Date(runAt).getTime() } };
    else if (kind === "recurringMessage") input = { name, action: { kind, threadId, prompt, everyMinutes: recurringMinutes, startInMinutes: recurringMinutes } };
    else if (kind === "scheduledMessage") input = { name, action: { kind, threadId, prompt, runAt: new Date(runAt).getTime() } };
    else input = { name, action: { kind, threadId, prompt, weekdays, minuteOfDay: hour * 60 + minute, timezoneOffsetMinutes: new Date().getTimezoneOffset() } };
    setBusy(true); setError(null);
    try { if (editing) await updateAutomation(editing.id, automationUpdateInput(input, editing)); else await createAutomation(input); setName(""); setPrompt(""); refresh(); setView("overview"); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  }

  const creatingPipeline = view === "createPipeline";
  const unchangedDate = editing && "runAt" in editing.action && runAt === automationDateTimeValue(editing.action.runAt);
  const validSchedule = creatingPipeline
    ? pipelineTiming === "delay" ? Number(minutes) >= 1 : (unchangedDate || new Date(runAt).getTime() > Date.now())
    : kind === "scheduledMessage" ? (unchangedDate || new Date(runAt).getTime() > Date.now()) : kind !== "calendarMessage" || weekdays.length > 0;
  const valid = name.trim() && validSchedule && (creatingPipeline
    ? fromCategory && toCategory && fromCategory !== toCategory
    : threadId && prompt.trim() && (kind !== "recurringMessage" || Number.isInteger(Number(intervalValue)) && Number(intervalValue) >= 1 && Number.isSafeInteger(recurringMinutes) && recurringMinutes <= 525_600));

  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="automations-dialog" role="dialog" aria-modal="true" aria-label="Automations">
    <header><div>{view !== "overview" && <button className="automation-back" onClick={() => setView("overview")}>← All workflows</button>}<span className="eyebrow">Workflows</span><h2>{view === "overview" ? "Automations & pipelines" : editing ? creatingPipeline ? "Edit pipeline" : "Edit automation" : creatingPipeline ? "New pipeline" : "New automation"}</h2><p>{view === "overview" ? "Review schedules by project and coordinate upcoming work." : creatingPipeline ? "Move tasks between categories after a delay or at a specific date." : "Schedule a prompt for a Codex task."}</p></div><button className="icon-button" onClick={onClose}>×</button></header>
    {view !== "overview" ? <form className="automation-form automation-create-view" onSubmit={(event) => void submit(event)}>
      {creatingPipeline ? <div className="automation-tabs"><button type="button" className={pipelineTiming === "delay" ? "active" : ""} onClick={() => setPipelineTiming("delay")}>After time</button><button type="button" className={pipelineTiming === "scheduled" ? "active" : ""} onClick={() => setPipelineTiming("scheduled")}>Specific date</button></div> : <div className="automation-tabs automation-tabs-three"><button type="button" className={kind === "recurringMessage" ? "active" : ""} onClick={() => setKind("recurringMessage")}>Interval</button><button type="button" className={kind === "scheduledMessage" ? "active" : ""} onClick={() => setKind("scheduledMessage")}>Once</button><button type="button" className={kind === "calendarMessage" ? "active" : ""} onClick={() => setKind("calendarMessage")}>Calendar</button></div>}
      <label><span>Name</span><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Daily project check" /></label>
      {!creatingPipeline && <ScheduleTaskPicker tasks={scheduleThreads} selectedId={threadId} onSelect={setThreadId}/>}
      {!creatingPipeline ? <><label><span>Project</span><select value={taskProjectKey} onChange={(event) => { const key = event.target.value; setTaskProjectKey(key); setThreadId(threads.find((thread) => thread.projectKey === key)?.id || ""); }}>{taskProjects.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><div className="automation-task-picker">{threadId && !threadsById.has(threadId) && <p className="automation-task-empty">Current task is unavailable ({threadId}). Select a task to change the target.</p>}<span className="automation-task-picker-label">Active tasks · {projectThreads.length}</span>{projectThreads.length ? <div className="automation-task-grid">{projectThreads.map((thread) => <button type="button" key={thread.id} className={`automation-task-option${threadId === thread.id ? " selected" : ""}`} aria-pressed={threadId === thread.id} onClick={() => setThreadId(thread.id)}><strong>{thread.displayTitle}</strong><small>{thread.category} · Updated {thread.updatedAt ? new Date(thread.updatedAt).toLocaleDateString() : "recently"}</small></button>)}</div> : <p className="automation-task-empty">No active tasks in this project.</p>}</div><label><span>Prompt</span><textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="Review progress and continue the next useful step" /></label></> : <div className="pipeline-fields"><label><span>From</span><select value={fromCategory} onChange={(event) => setFromCategory(event.target.value)}>{[...new Set([...categories, fromCategory, toCategory].filter(Boolean))].map((category) => <option key={category}>{category}</option>)}</select></label><b>→</b><label><span>To</span><select value={toCategory} onChange={(event) => setToCategory(event.target.value)}>{[...new Set([...categories, fromCategory, toCategory].filter(Boolean))].map((category) => <option key={category}>{category}</option>)}</select></label></div>}
      {!creatingPipeline && kind === "recurringMessage" && <label><span>Repeat every</span><div className="number-field"><input type="number" min="1" max={intervalUnit === "days" ? 365 : intervalUnit === "hours" ? 8_760 : 525_600} value={intervalValue} onChange={(event) => setIntervalValue(event.target.value)} /><select className="automation-interval-unit" value={intervalUnit} onChange={(event) => setIntervalUnit(event.target.value as AutomationIntervalUnit)}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option></select></div></label>}
      {!creatingPipeline && kind === "scheduledMessage" && <label><span>Run once</span><input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></label>}
      {!creatingPipeline && kind === "calendarMessage" && <>{editing?.action.kind === "calendarMessage" && <p className="automation-edit-note">Calendar uses saved timezone: UTC{editing.action.timezoneOffsetMinutes <= 0 ? "+" : "−"}{Math.abs(editing.action.timezoneOffsetMinutes) / 60}.</p>}<label><span>Time</span><input type="time" value={time} onChange={(event) => setTime(event.target.value)} /></label><div className="weekday-picker">{DAYS.map(([day, label]) => <button type="button" key={day} className={weekdays.includes(day) ? "active" : ""} onClick={() => setWeekdays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day])}>{label}</button>)}</div></>}
      {creatingPipeline && pipelineTiming === "delay" && <label><span>Move after</span><div className="number-field"><input type="number" min="1" value={minutes} onChange={(event) => setMinutes(event.target.value)} /><small>minutes in category</small></div></label>}
      {creatingPipeline && pipelineTiming === "scheduled" && <label><span>Move on</span><input type="datetime-local" value={runAt} onChange={(event) => setRunAt(event.target.value)} /></label>}
      {editing && <p className="automation-edit-note">Changes apply to future runs. Queued or running work is unchanged. Paused workflows stay paused.</p>}
      {error && <p className="automation-form-error">{error}</p>}<div className="automation-create-actions"><button type="button" className="secondary" onClick={() => setView("overview")}>Cancel</button><button className="automation-submit" disabled={busy || !valid}>{busy ? "Saving…" : editing ? "Save changes" : creatingPipeline ? "Create pipeline" : "Create automation"}</button></div>
    </form> : <div className="automation-list automation-overview">
      <div className="automation-list-heading"><div><span className="eyebrow">Orchestration</span><strong>Automation schedule</strong></div><div className="automation-list-actions"><select aria-label="Filter automations by project" value={projectFilter} onChange={(event) => setProjectFilter(event.target.value)}><option value={ALL_PROJECTS}>All projects</option>{projectOptions.map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><button className="automation-new" onClick={() => beginCreate("createAutomation")}>+ Automation</button><button className="pipeline-new" onClick={() => beginCreate("createPipeline")}>→ Pipeline</button></div></div>
      <div className="automation-stats"><div><strong>{items.length}</strong><span>Total</span></div><div><strong>{activeCount}</strong><span>Active</span></div><div><strong>{nextDayCount}</strong><span>Next 24h</span></div></div>
      <div className="automation-bulk-actions"><RetrySelectedAutomations items={items} onAccepted={refresh}/></div>
      {error && <p role="alert" className="automation-form-error">{error}</p>}
      {items.length === 0 && <div className="automation-empty">No automations yet.</div>}
      {items.length > 0 && groups.length === 0 && <div className="automation-empty">No automations for this project.</div>}
      {groups.map((group) => <section className="automation-project-group" key={group.key}><div className="automation-project-heading"><div><span className="automation-project-mark" /> <strong>{group.label}</strong></div><span>{group.automations.length}</span></div><div className="automation-cards">{group.automations.map((automation) => <article className="automation-item" key={automation.id}><div className="automation-card-top"><span className="automation-kind">{isPipeline(automation) ? "→" : automation.action.kind === "scheduledMessage" ? "◷" : "↻"}</span><span className={`automation-status${automation.enabled ? " enabled" : ""}`}>{automation.enabled ? "Active" : "Paused"}</span></div><strong className="automation-card-title">{automation.name}</strong><p>{automationCopy(automation, threadNames)}</p><em className={automation.enabled ? "" : "paused"}>{nextRunCopy(automation)}</em>{automation.runState && <span className="automation-outcome unknown">{automation.runState === "queued" ? "Queued" : "Running"}</span>}
        {automation.lastResult ? <div className="automation-last-result"><span className={`automation-outcome ${automationOutcome(automation.lastResult.status).tone}`}>{automationOutcome(automation.lastResult.status).label}</span><p>{automation.lastResult.summary}</p></div> : automation.lastError ? <small>{automation.lastError}</small> : <span className="automation-outcome unknown">No verified result yet</span>}{automation.lastResult && automationOutcome(automation.lastResult.status).retryable && <RetryAutomationButton key={automation.lastResult.finishedAt} id={automation.id} disabled={automation.runState === "running"} onAccepted={refresh}/>}<div className="automation-card-actions"><button aria-label={automation.enabled ? `Pause ${automation.name}` : `Resume ${automation.name}`} className={automation.enabled ? "automation-toggle on" : "automation-toggle"} onClick={() => void setAutomationEnabled(automation.id, !automation.enabled).then(refresh)}><i /></button><button type="button" className="automation-edit" aria-label={`Edit ${automation.name}`} onClick={() => edit(automation)}><Icon name="edit" width={16} height={16} /> Edit</button><button type="button" className="automation-delete" aria-label={`Delete ${automation.name}`} title="Delete workflow" onClick={() => void deleteAutomation(automation.id).then(refresh)}><Icon name="trash" width={20} height={20}/></button></div></article>)}</div></section>)}
    </div>}
  </section></div>;
}
