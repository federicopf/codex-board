import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useDraggable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates, useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { asCodexError, clearNotifications, createThread, drainCodexEvents, getBoardConfig, getMessageQueues, listNotifications, listThreads, markNotificationsRead, removeQueuedMessage as removeQueuedMessageApi, renameThread, sendMessage, setBoardConfig } from "./api";
import type { BoardNotification } from "@codex-board/protocol";
import "./App.css";
import { CategoryDialog } from "./CategoryDialog";
import { ChatPanel } from "./ChatPanel";
import { RemoteDialog } from "./RemoteDialog";
import { AutomationsDialog } from "./AutomationsDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { ProductTour } from "./ProductTour";
import { InboxDialog } from "./InboxDialog";
import { moveThread, toBoardThreads } from "./lib/board";
import { loadApprovalMode, saveApprovalMode, type ApprovalMode } from "./lib/approvals";
import {
  createCategory,
  loadCategoryOrder,
  moveCategory,
  reconcileCategoryOrder,
  renameCategory,
  saveCategoryOrder,
} from "./lib/categoryOrder";
import { ALL_PROJECTS, projectOptions, buildProjectMap } from "./lib/projects";
import { buildThreadTitle, threadCategories, UNCATEGORIZED } from "./lib/threadStatus";
import type { BoardThread, CodexError, CodexEvent, JsonValue, QueuedMessage, SequencedCodexEvent } from "./types";

const THREAD_DRAG_PREFIX = "thread:";
const CATEGORY_DRAG_PREFIX = "category:";
const threadDragId = (threadId: string) => `${THREAD_DRAG_PREFIX}${threadId}`;
const categoryDragId = (category: string) => `${CATEGORY_DRAG_PREFIX}${encodeURIComponent(category)}`;
const categoryFromDragId = (id: string) => decodeURIComponent(id.slice(CATEGORY_DRAG_PREFIX.length));
type JsonObject = Record<string, JsonValue>;
const record = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const eventThreadId = (event: CodexEvent): string => text(record(event.params).threadId);
type CategoryDialogState = { mode: "create" } | { mode: "rename"; category: string };
interface Toast { id: number; threadId: string; title: string; message: string; kind: "done" | "error"; }

function ThreadCard({
  thread,
  pending,
  working,
  queuedCount,
  showProject,
  onOpen,
  overlay = false,
}: {
  thread: BoardThread;
  pending: boolean;
  working: boolean;
  queuedCount: number;
  showProject: boolean;
  onOpen?: (threadId: string) => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: threadDragId(thread.id),
    disabled: pending || overlay,
  });
  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`thread-card${isDragging ? " is-dragging" : ""}${working ? " is-working" : ""}${overlay ? " overlay" : ""}`}
      {...listeners}
      {...attributes}
      aria-busy={pending}
    >
      <div className="card-title">{thread.displayTitle || "Untitled thread"}</div>
      {thread.preview && thread.preview.trim() !== thread.displayTitle && (
        <div className="card-preview">{thread.preview}</div>
      )}
      <footer>
        {showProject && <span className="project-chip">{thread.projectLabel}</span>}
        {pending && <span className="saving">Saving…</span>}
        {working && <span className="card-working"><i />Codex is working</span>}
        {queuedCount > 0 && <span className="queue-count">+{queuedCount} queued</span>}
        {!overlay && (
          <button
            className="open-thread"
            type="button"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onOpen?.(thread.id);
            }}
          >
            Chat
          </button>
        )}
      </footer>
    </article>
  );
}

function Column({
  category,
  threads,
  pendingIds,
  workingIds,
  queues,
  showProject,
  onOpen,
  onRename,
}: {
  category: string;
  threads: BoardThread[];
  pendingIds: Set<string>;
  workingIds: Set<string>;
  queues: Record<string, QueuedMessage[]>;
  showProject: boolean;
  onOpen: (threadId: string) => void;
  onRename: (category: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({
    id: categoryDragId(category),
  });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const hue = [...category].reduce((value, character) => value + character.charCodeAt(0), 0) % 360;
  return (
    <section ref={setNodeRef} style={style} className={`board-column${isOver ? " is-over" : ""}${isDragging ? " is-dragging-column" : ""}`}>
      <header className="column-header">
        <button className="column-drag-handle" type="button" aria-label={`Move ${category} column`} {...attributes} {...listeners}>⠿</button>
        <span className="status-dot" style={{ backgroundColor: `hsl(${hue} 55% 55%)` }} />
        <h2>{category}</h2>
        <span className="count">{threads.length}</span>
        <button className="column-rename" type="button" aria-label={`Rename ${category}`} onClick={() => onRename(category)}>✎</button>
      </header>
      <div className="column-body">
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            pending={pendingIds.has(thread.id)}
            working={workingIds.has(thread.id)}
            queuedCount={queues[thread.id]?.length || 0}
            showProject={showProject}
            onOpen={onOpen}
          />
        ))}
        {threads.length === 0 && <div className="column-empty">Drop a thread here</div>}
      </div>
    </section>
  );
}

function App() {
  const [threads, setThreads] = useState<BoardThread[]>([]);
  const [project, setProject] = useState(ALL_PROJECTS);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<CodexError | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<string | null>(null);
  const [categoryOrder, setCategoryOrder] = useState<string[]>(loadCategoryOrder);
  const [chatThreadId, setChatThreadId] = useState<string | null>(null);
  const [categoryDialog, setCategoryDialog] = useState<CategoryDialogState | null>(null);
  const [remoteDialog, setRemoteDialog] = useState(false);
  const [automationsDialog, setAutomationsDialog] = useState(false);
  const [newTaskDialog, setNewTaskDialog] = useState(false);
  const [productTour, setProductTour] = useState(() => localStorage.getItem("codex-board.tour.v1") !== "done");
  const [notifications, setNotifications] = useState<BoardNotification[]>([]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [events, setEvents] = useState<SequencedCodexEvent[]>([]);
  const [workingIds, setWorkingIds] = useState<Set<string>>(new Set());
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(loadApprovalMode);
  const workingIdsRef = useRef(workingIds);
  const queuesRef = useRef(queues);
  const threadsRef = useRef(threads);
  const eventSequence = useRef(0);
  const toastSequence = useRef(0);
  const approvalModeRef = useRef(approvalMode);
  const boardConfigReady = useRef(false);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const refresh = useCallback(async (background = false) => {
    background ? setRefreshing(true) : setLoading(true);
    try {
      const [result, serverQueues] = await Promise.all([listThreads(), getMessageQueues()]);
      setThreads(toBoardThreads(result));
      queuesRef.current = serverQueues;
      setQueues(serverQueues);
      const active = new Set(result.filter((thread) => text(record(thread.status).type) === "active").map((thread) => thread.id));
      workingIdsRef.current = active;
      setWorkingIds(active);
      setError(null);
    } catch (cause) {
      setError(asCodexError(cause));
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    void getBoardConfig().then(async (config) => {
      if (cancelled) return;
      const localCategories = loadCategoryOrder();
      const categories = config.categories.length ? config.categories : localCategories;
      const mode = config.revision > 0 ? config.approvalMode : loadApprovalMode();
      if (config.revision === 0 && (categories.length > 0 || mode !== config.approvalMode)) {
        await setBoardConfig({ categories, approvalMode: mode, revision: config.revision });
      }
      if (cancelled) return;
      setCategoryOrder(categories);
      setApprovalMode(mode);
      boardConfigReady.current = true;
    }).catch((cause) => { if (!cancelled) setError(asCodexError(cause)); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { workingIdsRef.current = workingIds; }, [workingIds]);
  useEffect(() => { queuesRef.current = queues; }, [queues]);
  useEffect(() => { const load=()=>void listNotifications().then(setNotifications); load(); const timer=window.setInterval(load,2000); return()=>window.clearInterval(timer); }, []);
  const persistBoardConfig = useCallback((categories: string[], mode: ApprovalMode) => {
    saveCategoryOrder(categories);
    saveApprovalMode(mode);
    if (boardConfigReady.current) void setBoardConfig({ categories, approvalMode: mode, revision: 0 }).catch((cause) => setError(asCodexError(cause)));
  }, []);
  useEffect(() => {
    approvalModeRef.current = approvalMode;
    saveApprovalMode(approvalMode);
    if (boardConfigReady.current) persistBoardConfig(categoryOrder, approvalMode);
  }, [approvalMode, persistBoardConfig]);

  const setThreadWorking = useCallback((threadId: string, working: boolean) => {
    setWorkingIds((current) => {
      const next = new Set(current);
      working ? next.add(threadId) : next.delete(threadId);
      workingIdsRef.current = next;
      return next;
    });
  }, []);

  const showToast = useCallback((threadId: string, message: string, kind: Toast["kind"] = "done") => {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    const toast: Toast = {
      id: ++toastSequence.current,
      threadId,
      title: thread?.displayTitle || thread?.effectiveTitle || "Codex",
      message,
      kind,
    };
    setToasts((current) => [...current, toast]);
    window.setTimeout(() => setToasts((current) => current.filter((item) => item.id !== toast.id)), 6500);
  }, []);

  useEffect(() => {
    let stopped = false;
    let polling = false;

    const finishTurn = (threadId: string, completedEvent: CodexEvent) => {
      if ((queuesRef.current[threadId]?.length || 0) > 0) return;
      setThreadWorking(threadId, false);
      setActiveTurns((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      const turn = record(record(completedEvent.params).turn);
      const status = text(turn.status);
      showToast(threadId, status === "failed" ? "Ho finito, ma il turno è terminato con un errore." : status === "interrupted" ? "Mi sono fermato." : "Hey, ho finito!", status === "failed" ? "error" : "done");
      void refresh(true);
    };

    const poll = async () => {
      if (stopped || polling) return;
      polling = true;
      try {
        const drained = await drainCodexEvents();
        if (stopped || drained.length === 0) return;
        const sequenced = drained.map((event) => ({ sequence: ++eventSequence.current, event }));
        setEvents((current) => [...current, ...sequenced].slice(-2000));
        for (const event of drained) {
          const threadId = eventThreadId(event);
          if (!threadId) continue;
          if (event.method === "board/queue/updated") {
            const messages = record(event.params).messages;
            const next = { ...queuesRef.current, [threadId]: Array.isArray(messages) ? messages as unknown as QueuedMessage[] : [] };
            if (next[threadId].length === 0) delete next[threadId];
            queuesRef.current = next;
            setQueues(next);
          } else if (event.method === "turn/started") {
            setThreadWorking(threadId, true);
            const turnId = text(record(record(event.params).turn).id);
            if (turnId) setActiveTurns((current) => ({ ...current, [threadId]: turnId }));
          } else if (event.method === "turn/completed") {
            finishTurn(threadId, event);
          }
        }
      } catch (cause) {
        if (!stopped) setError(asCodexError(cause));
      } finally {
        polling = false;
      }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), 120);
    return () => { stopped = true; window.clearInterval(timer); };
  }, [refresh, setThreadWorking, showToast]);

  const projects = useMemo(() => {
    const raw = threads.map(({ id, name, preview, cwd, updatedAt }) => ({
      id,
      name,
      preview,
      cwd,
      updatedAt,
    }));
    return projectOptions(buildProjectMap(raw));
  }, [threads]);

  useEffect(() => {
    if (project !== ALL_PROJECTS && !projects.some(({ key }) => key === project)) {
      setProject(ALL_PROJECTS);
    }
  }, [project, projects]);

  const visibleThreads = useMemo(
    () => (project === ALL_PROJECTS ? threads : threads.filter((item) => item.projectKey === project)),
    [project, threads],
  );
  const filteredThreads = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    if (!query) return visibleThreads;
    return visibleThreads.filter((thread) => [thread.displayTitle, thread.preview, thread.projectLabel]
      .some((value) => value?.toLocaleLowerCase().includes(query)));
  }, [search, visibleThreads]);
  const discoveredCategories = useMemo(
    () => threadCategories(threads.map((thread) => thread.category)),
    [threads],
  );
  useEffect(() => {
    setCategoryOrder((current) => {
      const next = reconcileCategoryOrder(current, discoveredCategories);
      if (next !== current) persistBoardConfig(next, approvalModeRef.current);
      return next;
    });
  }, [discoveredCategories, persistBoardConfig]);
  const categories = categoryOrder;
  const activeThread = threads.find((thread) => thread.id === activeId) ?? null;
  const chatThread = threads.find((thread) => thread.id === chatThreadId) ?? null;

  function createLocalCategory(name: string) {
    setCategoryOrder((current) => {
      const next = createCategory(current, name);
      persistBoardConfig(next, approvalModeRef.current);
      return next;
    });
    setCategoryDialog(null);
  }

  async function renameBoardCategory(currentCategory: string, nextCategory: string) {
    if (currentCategory === nextCategory) { setCategoryDialog(null); return; }
    const affected = threads.filter((thread) => thread.category === currentCategory);
    const completed: BoardThread[] = [];
    setCategoryBusy(true);
    setPendingIds((current) => new Set([...current, ...affected.map((thread) => thread.id)]));
    try {
      for (const thread of affected) {
        await renameThread(thread.id, buildThreadTitle(nextCategory, thread.displayTitle));
        completed.push(thread);
      }
      setThreads((current) => current.map((thread) => {
        if (thread.category !== currentCategory) return thread;
        const name = buildThreadTitle(nextCategory, thread.displayTitle);
        return { ...thread, category: nextCategory, name, effectiveTitle: name };
      }));
      setCategoryOrder((current) => {
        const next = currentCategory === UNCATEGORIZED
          ? createCategory(current, nextCategory)
          : renameCategory(current, currentCategory, nextCategory);
        persistBoardConfig(next, approvalModeRef.current);
        return next;
      });
      setCategoryDialog(null);
    } catch (cause) {
      let rollbackFailed = false;
      for (const thread of [...completed].reverse()) {
        try { await renameThread(thread.id, buildThreadTitle(currentCategory, thread.displayTitle)); }
        catch { rollbackFailed = true; }
      }
      const codexError = asCodexError(cause);
      setError({ ...codexError, message: rollbackFailed ? `${codexError.message} Some thread titles could not be rolled back.` : codexError.message });
      await refresh(true);
    } finally {
      setCategoryBusy(false);
      setPendingIds((current) => {
        const next = new Set(current);
        affected.forEach((thread) => next.delete(thread.id));
        return next;
      });
    }
  }

  async function sendOrQueue(threadId: string, message: string) {
    const wasWorking = workingIdsRef.current.has(threadId);
    if (!wasWorking) setThreadWorking(threadId, true);
    try {
      const response = await sendMessage(threadId, message);
      const turnId = text(record(response.turn).id);
      if (turnId) setActiveTurns((current) => ({ ...current, [threadId]: turnId }));
    } catch (cause) {
      if (!wasWorking) setThreadWorking(threadId, false);
      throw cause;
    }
  }

  function removeQueuedMessage(threadId: string, messageId: string) {
    void removeQueuedMessageApi(threadId, messageId).catch((cause) => setError(asCodexError(cause)));
  }

  function updateSessionState(threadId: string, running: boolean, turnId: string | null) {
    setThreadWorking(threadId, running);
    setActiveTurns((current) => {
      const next = { ...current };
      if (turnId) next[threadId] = turnId;
      else if (!running) delete next[threadId];
      return next;
    });
  }

  function handleDragStart(event: DragStartEvent) {
    const id = String(event.active.id);
    if (id.startsWith(CATEGORY_DRAG_PREFIX)) {
      setActiveCategory(categoryFromDragId(id));
      setActiveId(null);
    } else if (id.startsWith(THREAD_DRAG_PREFIX)) {
      setActiveId(id.slice(THREAD_DRAG_PREFIX.length));
      setActiveCategory(null);
    }
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    setActiveCategory(null);
    const activeDragId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : "";
    if (activeDragId.startsWith(CATEGORY_DRAG_PREFIX)) {
      if (!overId.startsWith(CATEGORY_DRAG_PREFIX)) return;
      const active = categoryFromDragId(activeDragId);
      const over = categoryFromDragId(overId);
      setCategoryOrder((current) => {
        const next = moveCategory(current, active, over);
        persistBoardConfig(next, approvalModeRef.current);
        return next;
      });
      return;
    }
    if (!activeDragId.startsWith(THREAD_DRAG_PREFIX) || !overId.startsWith(CATEGORY_DRAG_PREFIX)) return;
    const threadId = activeDragId.slice(THREAD_DRAG_PREFIX.length);
    if (pendingIds.has(threadId)) return;
    const targetCategory = categoryFromDragId(overId);
    const result = moveThread(threads, threadId, targetCategory);
    if (!result) return;

    setThreads(result.threads);
    setPendingIds((current) => new Set(current).add(threadId));
    try {
      const confirmed = await renameThread(threadId, result.newName);
      setThreads((current) => current.map((thread) => thread.id === threadId ? {
        ...thread,
        name: confirmed.name,
        preview: confirmed.preview,
        cwd: confirmed.cwd,
        updatedAt: confirmed.updatedAt,
      } : thread));
    } catch (cause) {
      setThreads((current) =>
        current.map((thread) => (thread.id === threadId ? result.previous : thread)),
      );
      setError(asCodexError(cause));
      void refresh(true);
    } finally {
      setPendingIds((current) => {
        const next = new Set(current);
        next.delete(threadId);
        return next;
      });
    }
  }

  if (loading) {
    return <div className="center-state"><div className="spinner" /><p>Loading Codex threads…</p></div>;
  }

  if (error?.code === "CLI_NOT_FOUND" && threads.length === 0) {
    return (
      <div className="center-state error-state">
        <div className="error-icon">!</div>
        <h1>Codex CLI not found</h1>
        <p>Install Codex for Windows, or set <code>CODEX_EXECUTABLE</code> to the full path of <code>codex.exe</code>.</p>
        <button onClick={() => void refresh()}>Try again</button>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragStart={handleDragStart} onDragEnd={(event) => void handleDragEnd(event)}>
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark"><span /><span /><span /></div>
            <div><h1>Codex Board</h1><p>Threads, organized.</p></div>
          </div>
          <div className="toolbar">
            <label className="toolbar-field">
              <span>Approvals</span>
              <select className="approval-mode" value={approvalMode} onChange={(event) => setApprovalMode(event.target.value as ApprovalMode)}>
                <option value="auto">Auto approve</option>
                <option value="ask">Ask every time</option>
              </select>
            </label>
            <label className="toolbar-field">
              <span>Project</span>
              <select value={project} onChange={(event) => setProject(event.target.value)}>
                <option value={ALL_PROJECTS}>All projects</option>
                {projects.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
            <button className="refresh-button" disabled={refreshing} onClick={() => void refresh(true)}>
              <span className={refreshing ? "spin" : ""}>↻</span> Refresh
            </button>
            <button className="new-task-button" onClick={() => setNewTaskDialog(true)}>＋ New task</button>
            <button className="new-category-button" onClick={() => setCategoryDialog({ mode: "create" })}>＋ Category</button>
            <button className="automation-button" onClick={() => setAutomationsDialog(true)}>⚡ Automations</button>
            <button className="help-button" onClick={() => setProductTour(true)} aria-label="Open product guide">?</button>
            <button className="inbox-button" onClick={() => setInboxOpen(true)} aria-label="Open inbox">♢{notifications.some(item=>!item.read)&&<b>{notifications.filter(item=>!item.read).length}</b>}</button>
            <button className="remote-button" onClick={() => setRemoteDialog(true)}><i />Remote</button>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error.message}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        <section className="board-heading">
          <div>
            <span className="eyebrow">Workspace</span>
            <h2>{project === ALL_PROJECTS ? "All projects" : projects.find((item) => item.key === project)?.label || "Project"}</h2>
            <p>Move work between stages and open any thread to continue with Codex.</p>
          </div>
          <div className="board-tools">
            <div className="board-metrics"><span><strong>{visibleThreads.length}</strong> threads</span><span className={workingIds.size ? "metric-live" : ""}><strong>{workingIds.size}</strong> working</span></div>
            <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search threads" /></label>
          </div>
        </section>

        {categories.length === 0 ? (
          <div className="empty-board">
            <h2>No threads here yet</h2>
            <p>{project === ALL_PROJECTS ? "Your Codex threads will appear automatically." : "This project has no visible threads."}</p>
          </div>
        ) : (
          <SortableContext items={categories.map(categoryDragId)} strategy={horizontalListSortingStrategy}>
            <div className="board">
              {categories.map((category) => (
                <Column
                  key={category}
                  category={category}
                  threads={filteredThreads.filter((thread) => thread.category === category)}
                  pendingIds={pendingIds}
                  workingIds={workingIds}
                  queues={queues}
                  showProject={project === ALL_PROJECTS}
                  onOpen={setChatThreadId}
                  onRename={(category) => setCategoryDialog({ mode: "rename", category })}
                />
              ))}
            </div>
          </SortableContext>
        )}
      </main>
      {chatThread && (
        <ChatPanel
          thread={chatThread}
          events={events}
          queuedMessages={queues[chatThread.id] || []}
          working={workingIds.has(chatThread.id)}
          activeTurnId={activeTurns[chatThread.id] || null}
          onSend={sendOrQueue}
          onRemoveQueued={removeQueuedMessage}
          onSessionState={updateSessionState}
          onClose={() => {
            setChatThreadId(null);
            void refresh(true);
          }}
        />
      )}
      {categoryDialog && (
        <CategoryDialog
          current={categoryDialog.mode === "rename" ? categoryDialog.category : undefined}
          categories={categoryOrder}
          busy={categoryBusy}
          onCancel={() => setCategoryDialog(null)}
          onSubmit={(name) => categoryDialog.mode === "create"
            ? createLocalCategory(name)
            : void renameBoardCategory(categoryDialog.category, name)}
        />
      )}
      {remoteDialog && <RemoteDialog onClose={() => setRemoteDialog(false)} />}
      {automationsDialog && <AutomationsDialog threads={threads} categories={categories} onClose={() => setAutomationsDialog(false)} />}
      {newTaskDialog && <NewTaskDialog threads={threads} categories={categories} onClose={() => setNewTaskDialog(false)} onCreate={async (cwd, category, title, prompt) => { const created = await createThread(cwd, category, title, prompt); await refresh(true); setChatThreadId(created.id); }} />}
      {productTour && <ProductTour onClose={() => { localStorage.setItem("codex-board.tour.v1", "done"); setProductTour(false); }} />}
      {inboxOpen && <InboxDialog items={notifications} onClose={()=>setInboxOpen(false)} onReadAll={()=>void markNotificationsRead().then(()=>listNotifications().then(setNotifications))} onClear={()=>void clearNotifications().then(()=>setNotifications([]))} onOpen={(threadId)=>{setInboxOpen(false);setChatThreadId(threadId);const item=notifications.find(entry=>entry.threadId===threadId&&!entry.read);if(item)void markNotificationsRead(item.id);}} />}
      <aside className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <button className={`completion-toast ${toast.kind}`} key={toast.id} onClick={() => {
            setChatThreadId(toast.threadId);
            setToasts((current) => current.filter((item) => item.id !== toast.id));
          }}>
            <span className="toast-icon">{toast.kind === "done" ? "✓" : "!"}</span>
            <span><strong>{toast.message}</strong><small>{toast.title}</small></span>
            <i onClick={(event) => { event.stopPropagation(); setToasts((current) => current.filter((item) => item.id !== toast.id)); }}>×</i>
          </button>
        ))}
      </aside>
      <DragOverlay>
        {activeThread ? <ThreadCard thread={activeThread} pending={false} working={workingIds.has(activeThread.id)} queuedCount={queues[activeThread.id]?.length || 0} showProject={project === ALL_PROJECTS} overlay /> : activeCategory ? <div className="column-overlay">{activeCategory}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}

export default App;
