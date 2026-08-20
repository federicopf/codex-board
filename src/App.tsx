import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { MoveThreadDialog } from "./MoveThreadDialog";
import { CategoryManagerDialog } from "./CategoryManagerDialog";
import { BoardSettingsDialog } from "./BoardSettingsDialog";
import { AutomationResultDialog } from "./AutomationResultDialog";
import {
  ALL_STATUSES,
  BoardWorkspace,
  CATEGORY_DRAG_PREFIX,
  categoryDragId,
  categoryFromDragId,
  THREAD_DRAG_PREFIX,
  ThreadDragOverlay,
} from "./BoardWorkspace";
import { moveThread, toBoardThreads } from "./lib/board";
import { loadApprovalMode, saveApprovalMode, type ApprovalMode } from "./lib/approvals";
import {
  createCategory,
  loadCategoryOrder,
  moveCategory,
  moveCategoryToPosition,
  reconcileCategoryOrder,
  renameCategory,
  saveCategoryOrder,
} from "./lib/categoryOrder";
import { ALL_PROJECTS, projectOptions, buildProjectMap } from "./lib/projects";
import { buildThreadTitle, threadCategories, UNCATEGORIZED } from "./lib/threadStatus";
import type { BoardThread, CodexError, CodexEvent, JsonValue, QueuedMessage, SequencedCodexEvent } from "./types";
type JsonObject = Record<string, JsonValue>;
const record = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const eventThreadId = (event: CodexEvent): string => text(record(event.params).threadId);
type CategoryDialogState = { mode: "create" } | { mode: "rename"; category: string };
interface Toast { id: number; threadId: string; title: string; message: string; kind: "done" | "error"; }

function App() {
  const [threads, setThreads] = useState<BoardThread[]>([]);
  const [project, setProject] = useState(ALL_PROJECTS);
  const [statusFilter, setStatusFilter] = useState(ALL_STATUSES);
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
  const [categoryManager, setCategoryManager] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [movingThreadId, setMovingThreadId] = useState<string | null>(null);
  const [remoteDialog, setRemoteDialog] = useState(false);
  const [automationsDialog, setAutomationsDialog] = useState(false);
  const [newTaskDialog, setNewTaskDialog] = useState(false);
  const [productTour, setProductTour] = useState(() => localStorage.getItem("codex-board.tour.v1") !== "done");
  const [notifications, setNotifications] = useState<BoardNotification[]>([]);
  const [automationAlerts, setAutomationAlerts] = useState<BoardNotification[]>([]);
  const [resultNotification, setResultNotification] = useState<BoardNotification | null>(null);
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
  const notificationIdsRef = useRef<Set<string> | null>(null);
  const automationTurnIdsRef = useRef(new Set<string>());
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
  useEffect(() => {
    const load = () => void listNotifications().then((items) => {
      const previous = notificationIdsRef.current;
      if (previous) {
        const fresh = items.filter((item) => item.automation && !previous.has(item.id));
        if (fresh.length) {
          setAutomationAlerts((current) => [...fresh, ...current].slice(0, 3));
          for (const item of fresh) {
            window.setTimeout(() => setAutomationAlerts((current) => current.filter((entry) => entry.id !== item.id)), 10_000);
          }
        }
      }
      notificationIdsRef.current = new Set(items.map((item) => item.id));
      setNotifications(items);
    });
    load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, []);
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

    const finishTurn = (threadId: string, completedEvent: CodexEvent, automated: boolean) => {
      if ((queuesRef.current[threadId]?.length || 0) > 0) return;
      setThreadWorking(threadId, false);
      setActiveTurns((current) => {
        const next = { ...current };
        delete next[threadId];
        return next;
      });
      const turn = record(record(completedEvent.params).turn);
      const status = text(turn.status);
      if (!automated) showToast(threadId, status === "failed" ? "Ho finito, ma il turno è terminato con un errore." : status === "interrupted" ? "Mi sono fermato." : "Hey, ho finito!", status === "failed" ? "error" : "done");
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
          if (event.method === "board/automation/turn-started") {
            const turnId = text(record(event.params).turnId);
            if (turnId) automationTurnIdsRef.current.add(turnId);
          } else if (event.method === "board/queue/updated") {
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
            const turnId = text(record(record(event.params).turn).id);
            const automated = automationTurnIdsRef.current.delete(turnId);
            finishTurn(threadId, event, automated);
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
  const populatedCategories = useMemo(() => categories.filter((category) => threads.some((thread) => thread.category === category)), [categories, threads]);
  const dashboardCategories = useMemo(
    () => categories.filter((category) => filteredThreads.some((thread) => thread.category === category)),
    [categories, filteredThreads],
  );
  const displayedCategories = statusFilter === ALL_STATUSES ? dashboardCategories : dashboardCategories.filter((category) => category === statusFilter);
  const activeThread = threads.find((thread) => thread.id === activeId) ?? null;
  const chatThread = threads.find((thread) => thread.id === chatThreadId) ?? null;
  const movingThread = threads.find((thread) => thread.id === movingThreadId) ?? null;

  useEffect(() => {
    if (statusFilter !== ALL_STATUSES && !populatedCategories.includes(statusFilter)) setStatusFilter(ALL_STATUSES);
  }, [populatedCategories, statusFilter]);

  function createLocalCategory(name: string) {
    setCategoryOrder((current) => {
      const next = createCategory(current, name);
      persistBoardConfig(next, approvalModeRef.current);
      return next;
    });
    setCategoryDialog(null);
  }

  function deleteEmptyCategory(category: string) {
    if (threads.some((thread) => thread.category === category)) return;
    setCategoryOrder((current) => {
      const next = current.filter((item) => item !== category);
      persistBoardConfig(next, approvalModeRef.current);
      return next;
    });
  }

  function setCategoryPosition(category: string, position: number) {
    setCategoryOrder((current) => {
      const next = moveCategoryToPosition(current, category, position);
      persistBoardConfig(next, approvalModeRef.current);
      return next;
    });
  }

  async function moveBoardThread(threadId: string, targetCategory: string, createNew = false) {
    if (pendingIds.has(threadId)) return;
    const result = moveThread(threads, threadId, targetCategory);
    if (!result) { setMovingThreadId(null); return; }
    if (createNew) {
      setCategoryOrder((current) => {
        const next = createCategory(current, targetCategory);
        persistBoardConfig(next, approvalModeRef.current);
        return next;
      });
    }
    setThreads(result.threads);
    setPendingIds((current) => new Set(current).add(threadId));
    try {
      const confirmed = await renameThread(threadId, result.newName);
      setThreads((current) => current.map((thread) => thread.id === threadId ? { ...thread, name: confirmed.name, preview: confirmed.preview, cwd: confirmed.cwd, updatedAt: confirmed.updatedAt } : thread));
      setMovingThreadId(null);
    } catch (cause) {
      setThreads((current) => current.map((thread) => thread.id === threadId ? result.previous : thread));
      if (createNew) deleteEmptyCategory(targetCategory);
      setError(asCodexError(cause));
      void refresh(true);
    } finally {
      setPendingIds((current) => { const next = new Set(current); next.delete(threadId); return next; });
    }
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
    const targetCategory = categoryFromDragId(overId);
    await moveBoardThread(threadId, targetCategory);
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
      <SortableContext items={displayedCategories.map(categoryDragId)} strategy={horizontalListSortingStrategy}>
        <BoardWorkspace
          project={project}
          statusFilter={statusFilter}
          search={search}
          projects={projects}
          populatedCategories={populatedCategories}
          displayedCategories={displayedCategories}
          filteredThreads={filteredThreads}
          visibleThreadCount={visibleThreads.length}
          workingCount={workingIds.size}
          pendingIds={pendingIds}
          workingIds={workingIds}
          queues={queues}
          notifications={notifications}
          refreshing={refreshing}
          onProjectChange={setProject}
          onStatusChange={setStatusFilter}
          onSearchChange={setSearch}
          onRefresh={() => void refresh(true)}
          onCategories={() => setCategoryManager(true)}
          onAutomations={() => setAutomationsDialog(true)}
          onNewTask={() => setNewTaskDialog(true)}
          onSettings={() => setSettingsOpen(true)}
          onGuide={() => setProductTour(true)}
          onInbox={() => setInboxOpen(true)}
          onRemote={() => setRemoteDialog(true)}
          onOpen={setChatThreadId}
          onMove={setMovingThreadId}
          onRename={(category) => setCategoryDialog({ mode: "rename", category })}
        />
      </SortableContext>
      {error && <div className="error-banner" role="alert"><span>{error.message}</span><button onClick={() => setError(null)} aria-label="Dismiss">×</button></div>}
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
      {categoryManager && <CategoryManagerDialog categories={categories} threads={threads} onClose={() => setCategoryManager(false)} onCreate={() => { setCategoryManager(false); setCategoryDialog({ mode: "create" }); }} onRename={(category) => { setCategoryManager(false); setCategoryDialog({ mode: "rename", category }); }} onDelete={deleteEmptyCategory} onPosition={setCategoryPosition} />}
      {movingThread && <MoveThreadDialog thread={movingThread} categories={categories} busy={pendingIds.has(movingThread.id)} onClose={() => setMovingThreadId(null)} onMove={(category, create) => void moveBoardThread(movingThread.id, category, create)} />}
      {settingsOpen && <BoardSettingsDialog approvalMode={approvalMode} onApprovalMode={setApprovalMode} onClose={() => setSettingsOpen(false)} />}
      {remoteDialog && <RemoteDialog onClose={() => setRemoteDialog(false)} />}
      {automationsDialog && <AutomationsDialog threads={threads} categories={categories} onClose={() => setAutomationsDialog(false)} />}
      {newTaskDialog && <NewTaskDialog threads={threads} categories={categories} onClose={() => setNewTaskDialog(false)} onCreate={async (cwd, category, title, prompt) => { const created = await createThread(cwd, category, title, prompt); await refresh(true); setChatThreadId(created.id); }} />}
      {productTour && <ProductTour onClose={() => { localStorage.setItem("codex-board.tour.v1", "done"); setProductTour(false); }} />}
      {inboxOpen && <InboxDialog items={notifications} onClose={()=>setInboxOpen(false)} onReadAll={()=>void markNotificationsRead().then(()=>listNotifications().then(setNotifications))} onClear={()=>void clearNotifications().then(()=>setNotifications([]))} onOpenResult={(item)=>{setInboxOpen(false);setResultNotification(item);if(!item.read)void markNotificationsRead(item.id);}} onOpen={(threadId)=>{setInboxOpen(false);setChatThreadId(threadId);const item=notifications.find(entry=>entry.threadId===threadId&&!entry.read);if(item)void markNotificationsRead(item.id);}} />}
      {resultNotification && <AutomationResultDialog notification={resultNotification} onClose={()=>setResultNotification(null)} onOpenThread={(threadId)=>{setResultNotification(null);setChatThreadId(threadId);}} />}
      <aside className="toast-stack" aria-live="polite">
        {automationAlerts.map((item) => <button className="completion-toast automation-alert" key={item.id} onClick={()=>{setResultNotification(item);setAutomationAlerts((current)=>current.filter((entry)=>entry.id!==item.id));if(!item.read)void markNotificationsRead(item.id);}}><span className="toast-icon">⚡</span><span><strong>Automation completed</strong><small>{item.automation?.name}</small></span><i onClick={(event)=>{event.stopPropagation();setAutomationAlerts((current)=>current.filter((entry)=>entry.id!==item.id));}}>×</i></button>)}
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
        {activeThread ? <ThreadDragOverlay thread={activeThread} pending={false} working={workingIds.has(activeThread.id)} queuedCount={queues[activeThread.id]?.length || 0} showProject={project === ALL_PROJECTS} /> : activeCategory ? <div className="column-overlay">{activeCategory}</div> : null}
      </DragOverlay>
    </DndContext>
  );
}

export default App;
