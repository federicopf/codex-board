import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy, sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { asCodexError, clearNotifications, createThread, archiveThread, deleteCustomer as deleteCustomerApi, drainCodexEvents, forkThread, getBoardConfig, getMessageQueues, getRateLimits, interruptTurn, listNotifications, listThreads, markNotificationsRead, removeQueuedMessage as removeQueuedMessageApi, renameThread, sendMessage, setBoardConfig } from "./api";
import type { BoardNotification, ProjectCustomer } from "@codex-board/protocol";
import { turnPreferences } from "./lib/turnSettings";
import { setTurnSettings } from "./api";
import "./App.css";
import { CategoryDialog } from "./CategoryDialog";
import { ChatPanel } from "./ChatPanel";
import { RemoteDialog } from "./RemoteDialog";
import { AutomationsDialog } from "./AutomationsDialog";
import { NewTaskDialog } from "./NewTaskDialog";
import { NewProjectDialog } from "./NewProjectDialog";
import { NewCustomerDialog } from "./NewCustomerDialog";
import { ForkThreadDialog } from "./ForkThreadDialog";
import { RenameThreadDialog } from "./RenameThreadDialog";
import { loadThread } from "./api";
import { threadNameWithTitle } from "@codex-board/protocol";
import { ProductTour } from "./ProductTour";
import { InboxDialog } from "./InboxDialog";
import { MoveThreadDialog } from "./MoveThreadDialog";
import { CategoryManagerDialog } from "./CategoryManagerDialog";
import { BoardSettingsDialog } from "./BoardSettingsDialog";
import { AutomationResultDialog } from "./AutomationResultDialog";
import { ConfirmArchiveDialog } from "./ConfirmArchiveDialog";
import {
  BoardWorkspace,
  CATEGORY_DRAG_PREFIX,
  PROJECT_DROP_PREFIX,
  categoryDragId,
  categoryFromDragId,
  projectFromDropId,
  CUSTOMER_DROP_PREFIX,
  customerFromDropId,
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
import type { BoardThread, CodexError, CodexEvent, JsonValue, QueuedMessage, SequencedCodexEvent, ThreadDto, TurnSettings } from "./types";
type JsonObject = Record<string, JsonValue>;
const record = (value: JsonValue | undefined): JsonObject => value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
const text = (value: JsonValue | undefined): string => typeof value === "string" ? value : "";
const eventThreadId = (event: CodexEvent): string => text(record(event.params).threadId);
type CategoryDialogState = { mode: "create" } | { mode: "rename"; category: string };
type ArchiveDialogState = { kind: "thread"; threadId: string; title: string } | { kind: "project"; projectKey: string; title: string; threadIds: string[] };
interface Toast { id: number; threadId: string; title: string; message: string; kind: "done" | "error"; }
const PROJECT_BOARD_KEY = "codex-board.project-board.v1";
const PROJECT_CUSTOMER_KEY = "codex-board.project-customer.v1";

function App() {
  const [threads, setThreads] = useState<BoardThread[]>([]);
  const [project, setProject] = useState(() => localStorage.getItem(PROJECT_BOARD_KEY) || ALL_PROJECTS);
  const [customerId, setCustomerId] = useState<string | null>(() => localStorage.getItem(PROJECT_CUSTOMER_KEY));
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
  const [forkingThreadId, setForkingThreadId] = useState<string | null>(null);
  const [forkBusy, setForkBusy] = useState(false);
  const [renamingThreadId, setRenamingThreadId] = useState<string | null>(null);
  const [remoteDialog, setRemoteDialog] = useState(false);
  const [automationsDialog, setAutomationsDialog] = useState(false);
  const [automationRevision, setAutomationRevision] = useState(0);
  const [newTaskDialog, setNewTaskDialog] = useState(false);
  const [newProjectDialog, setNewProjectDialog] = useState(false);
  const [projectPaths, setProjectPaths] = useState<string[]>([]);
  const [customers, setCustomers] = useState<ProjectCustomer[]>([]);
  const [customerToDelete, setCustomerToDelete] = useState<ProjectCustomer | null>(null);
  const [customerDeleteBusy, setCustomerDeleteBusy] = useState(false);
  const [newCustomerProjectKey, setNewCustomerProjectKey] = useState<string | null>(null);
  const [productTour, setProductTour] = useState(() => localStorage.getItem("codex-board.tour.v1") !== "done");
  const [notifications, setNotifications] = useState<BoardNotification[]>([]);
  const [automationAlerts, setAutomationAlerts] = useState<BoardNotification[]>([]);
  const [resultNotification, setResultNotification] = useState<BoardNotification | null>(null);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxInitialTab, setInboxInitialTab] = useState<"notifications" | "automations">("notifications");
  const [categoryBusy, setCategoryBusy] = useState(false);
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogState | null>(null);
  const [archiveBusy, setArchiveBusy] = useState(false);
  const [events, setEvents] = useState<SequencedCodexEvent[]>([]);
  const [workingIds, setWorkingIds] = useState<Set<string>>(new Set());
  const [activeTurns, setActiveTurns] = useState<Record<string, string>>({});
  const [queues, setQueues] = useState<Record<string, QueuedMessage[]>>({});
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>(loadApprovalMode);
  const [rateLimits, setRateLimits] = useState<JsonValue | null>(null);
  const workingIdsRef = useRef(workingIds);
  const turnStateRevision = useRef(0);
  const queuesRef = useRef(queues);
  const queueRevision = useRef(0);
  const refreshRequest = useRef(0);
  const threadsRef = useRef(threads);
  const eventSequence = useRef(0);
  const toastSequence = useRef(0);
  const approvalModeRef = useRef(approvalMode);
  const projectPathsRef = useRef(projectPaths);
  const customersRef = useRef(customers);
  const boardConfigReady = useRef(false);
  const notificationIdsRef = useRef<Set<string> | null>(null);
  const automationTurnIdsRef = useRef(new Set<string>());
  const pendingThreadIdsRef = useRef(new Map<string, BoardThread>());
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const refresh = useCallback(async (background = false) => {
    background ? setRefreshing(true) : setLoading(true);
    const request = ++refreshRequest.current;
    const requestedTurnRevision = turnStateRevision.current;
    const requestedQueueRevision = queueRevision.current;
    try {
      const [result, serverQueues] = await Promise.all([listThreads(), getMessageQueues()]);
      if (request !== refreshRequest.current) return;
      const fetchedThreads = toBoardThreads(result);
      const fetchedIds = new Set(fetchedThreads.map((thread) => thread.id));
      for (const [id, thread] of pendingThreadIdsRef.current) {
        if (fetchedIds.has(id)) pendingThreadIdsRef.current.delete(id);
        else fetchedThreads.push(thread);
      }
      setThreads(fetchedThreads);
      if (queueRevision.current === requestedQueueRevision) {
        queuesRef.current = serverQueues;
        setQueues(serverQueues);
      }
      if (turnStateRevision.current === requestedTurnRevision) {
        const active = new Set(result.filter((thread) => text(record(thread.status).type) === "active").map((thread) => thread.id));
        workingIdsRef.current = active;
        setWorkingIds(active);
      }
      setError(null);
    } catch (cause) {
      if (request === refreshRequest.current) setError(asCodexError(cause));
    } finally {
      if (request === refreshRequest.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let cancelled = false;
    const load = () => void getRateLimits().then((value) => { if (!cancelled) setRateLimits(value); }).catch(() => undefined);
    load();
    const timer = window.setInterval(load, 60_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void getBoardConfig().then(async (config) => {
      if (cancelled) return;
      const localCategories = loadCategoryOrder();
      const categories = config.categories.length ? config.categories : localCategories;
      const projects = [...(config.projects || [])];
      const savedCustomers = config.customers || [];
      for (const thread of threadsRef.current) if (thread.cwd && !projects.some((cwd) => cwd.toLocaleLowerCase() === thread.cwd!.toLocaleLowerCase())) projects.push(thread.cwd);
      const mode = config.revision > 0 ? config.approvalMode : loadApprovalMode();
      const localTurnSettings: TurnSettings = {
        model: localStorage.getItem("codex-board.model") || undefined,
        effort: localStorage.getItem("codex-board.effort") || undefined,
        summary: localStorage.getItem("codex-board.summary") || "auto",
        serviceTier: localStorage.getItem("codex-board.serviceTier") || undefined,
      };
      // Migrate the PC's existing preference once; subsequent snapshots are shared.
      if (!config.turnSettings?.model && localTurnSettings.model) {
        turnPreferences.receive(await setTurnSettings(localTurnSettings, true));
      } else {
        turnPreferences.receive(config);
      }
      const turnSettings = turnPreferences.getSnapshot().settings;
      if (config.revision === 0 || projects.length !== (config.projects || []).length) {
        await setBoardConfig({ categories, projects, customers: savedCustomers, approvalMode: mode, turnSettings, revision: config.revision });
      }
      if (cancelled) return;
      setCategoryOrder(categories);
      projectPathsRef.current = projects;
      customersRef.current = savedCustomers;
      setCustomers(savedCustomers);
      setProjectPaths(projects);
      setApprovalMode(mode);
      boardConfigReady.current = true;
    }).catch((cause) => { if (!cancelled) { turnPreferences.unavailable(cause); setError(asCodexError(cause)); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => { threadsRef.current = threads; }, [threads]);
  useEffect(() => { workingIdsRef.current = workingIds; }, [workingIds]);
  useEffect(() => { queuesRef.current = queues; }, [queues]);
  useEffect(() => {
    const load = () => void listNotifications().then((items) => {
      const activeThreadNotifications = items.filter((item) => item.threadId === chatThreadId && !item.read);
      if (activeThreadNotifications.length) {
        for (const item of activeThreadNotifications) void markNotificationsRead(item.id);
      }
      const normalizedItems = activeThreadNotifications.length
        ? items.map((item) => activeThreadNotifications.some((active) => active.id === item.id) ? { ...item, read: true } : item)
        : items;
      const previous = notificationIdsRef.current;
      if (previous) {
        const fresh = normalizedItems.filter((item) => item.automation && !previous.has(item.id) && item.threadId !== chatThreadId);
        if (fresh.length) {
          setAutomationAlerts((current) => [...fresh, ...current].slice(0, 3));
          for (const item of fresh) {
            window.setTimeout(() => setAutomationAlerts((current) => current.filter((entry) => entry.id !== item.id)), 10_000);
          }
        }
      }
      notificationIdsRef.current = new Set(normalizedItems.map((item) => item.id));
      setNotifications(normalizedItems);
    });
    load();
    const timer = window.setInterval(load, 2000);
    return () => window.clearInterval(timer);
  }, [chatThreadId]);
  const persistBoardConfig = useCallback((categories: string[], mode: ApprovalMode, projects = projectPathsRef.current, nextCustomers = customersRef.current) => {
    saveCategoryOrder(categories);
    saveApprovalMode(mode);
    projectPathsRef.current = projects;
    if (boardConfigReady.current) void setBoardConfig({ categories, projects, customers: nextCustomers, approvalMode: mode, turnSettings: turnPreferences.getSnapshot().settings, revision: 0 }).catch((cause) => setError(asCodexError(cause)));
  }, []);
  useEffect(() => {
    approvalModeRef.current = approvalMode;
    saveApprovalMode(approvalMode);
    if (boardConfigReady.current) persistBoardConfig(categoryOrder, approvalMode);
  }, [approvalMode, persistBoardConfig]);

  const setThreadWorking = useCallback((threadId: string, working: boolean) => {
    turnStateRevision.current += 1;
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
      title: thread ? `${thread.projectLabel} · ${thread.displayTitle || thread.effectiveTitle || "Untitled thread"}` : "Codex",
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
          if (["board/automations/updated", "board/automation/submitting", "board/automation/queued"].includes(event.method)) setAutomationRevision(value => value + 1);
          if (event.method === "board/config/updated") {
            const config = record(event.params);
            const nextCategories = Array.isArray(config.categories) ? config.categories.filter((item): item is string => typeof item === "string") : [];
            const nextProjects = Array.isArray(config.projects) ? config.projects.filter((item): item is string => typeof item === "string") : [];
            const nextMode = config.approvalMode === "ask" ? "ask" : "auto";
            const nextTurnSettings = record(config.turnSettings);
            const turnSettings: TurnSettings = {
              model: typeof nextTurnSettings.model === "string" ? nextTurnSettings.model : undefined,
              effort: typeof nextTurnSettings.effort === "string" ? nextTurnSettings.effort : undefined,
              summary: typeof nextTurnSettings.summary === "string" ? nextTurnSettings.summary : "auto",
              serviceTier: typeof nextTurnSettings.serviceTier === "string" ? nextTurnSettings.serviceTier : undefined,
            };
            turnPreferences.receive({ revision: typeof config.revision === "number" ? config.revision : 0, turnSettings });
            projectPathsRef.current = nextProjects;
            setProjectPaths(nextProjects);
            setCategoryOrder(nextCategories);
            setApprovalMode(nextMode);
            continue;
          }
          const threadId = eventThreadId(event);
          if (!threadId) continue;
          if (event.method === "board/automation/turn-started") {
            const turnId = text(record(event.params).turnId);
            if (turnId) automationTurnIdsRef.current.add(turnId);
          } else if (event.method === "board/queue/updated") {
            const messages = record(event.params).messages;
            const next = { ...queuesRef.current, [threadId]: Array.isArray(messages) ? messages as unknown as QueuedMessage[] : [] };
            if (next[threadId].length === 0) delete next[threadId];
            queueRevision.current += 1;
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
    return projectOptions(buildProjectMap(raw, projectPaths));
  }, [projectPaths, threads]);

  useEffect(() => {
    const discovered = threads.flatMap((thread) => thread.cwd ? [thread.cwd] : []);
    const next = [...projectPaths];
    for (const cwd of discovered) if (!next.some((item) => item.toLocaleLowerCase() === cwd.toLocaleLowerCase())) next.push(cwd);
    if (next.length !== projectPaths.length) {
      setProjectPaths(next);
      persistBoardConfig(categoryOrder, approvalModeRef.current, next);
    }
  }, [categoryOrder, persistBoardConfig, projectPaths, threads]);

  useEffect(() => {
    if (!loading && project !== ALL_PROJECTS && !projects.some(({ key }) => key === project)) {
      setProject(ALL_PROJECTS);
      localStorage.setItem(PROJECT_BOARD_KEY, ALL_PROJECTS);
    }
  }, [loading, project, projects]);

  const selectProjectBoard = useCallback((key: string) => {
    setProject(key);
    setCustomerId(null);
    localStorage.removeItem(PROJECT_CUSTOMER_KEY);
    setSearch("");
    localStorage.setItem(PROJECT_BOARD_KEY, key);
  }, []);

  function createProject(cwd: string) {
    const next = [...projectPathsRef.current, cwd];
    projectPathsRef.current = next;
    setProjectPaths(next);
    persistBoardConfig(categoryOrder, approvalModeRef.current, next);
    setNewProjectDialog(false);
    selectProjectBoard(buildProjectMap([], [cwd]).keys().next().value || ALL_PROJECTS);
  }

  function selectCustomerBoard(projectKey: string, nextCustomerId: string | null) {
    selectProjectBoard(projectKey);
    setCustomerId(nextCustomerId);
    if (nextCustomerId) localStorage.setItem(PROJECT_CUSTOMER_KEY, nextCustomerId);
    else localStorage.removeItem(PROJECT_CUSTOMER_KEY);
  }

  function createCustomer(name: string) {
    const projectInfo = projects.find((item) => item.key === newCustomerProjectKey);
    if (!projectInfo) return;
    const next = [...customersRef.current, { id: crypto.randomUUID(), projectCwd: projectInfo.cwd, name, threadIds: [] }];
    customersRef.current = next; setCustomers(next);
    persistBoardConfig(categoryOrder, approvalModeRef.current, projectPathsRef.current, next);
    setCustomerId(next.at(-1)!.id);
    localStorage.setItem(PROJECT_CUSTOMER_KEY, next.at(-1)!.id);
    setNewCustomerProjectKey(null);
  }

  async function confirmDeleteCustomer() {
    if (!customerToDelete) return;
    setCustomerDeleteBusy(true);
    try {
      const saved = await deleteCustomerApi(customerToDelete.id);
      customersRef.current = saved.customers;
      setCustomers(saved.customers);
      if (customerId === customerToDelete.id) selectCustomerBoard(project, null);
      setCustomerToDelete(null);
    } catch (cause) { setError(asCodexError(cause)); }
    finally { setCustomerDeleteBusy(false); }
  }

  function assignThreadToCustomer(threadId: string, nextCustomerId: string | null) {
    const next = customersRef.current.map((customer) => ({
      ...customer,
      threadIds: customer.id === nextCustomerId
        ? [...new Set([...customer.threadIds.filter((id) => id !== threadId), threadId])]
        : customer.threadIds.filter((id) => id !== threadId),
    }));
    customersRef.current = next; setCustomers(next);
    persistBoardConfig(categoryOrder, approvalModeRef.current, projectPathsRef.current, next);
  }

  const projectThreads = useMemo(() => project === ALL_PROJECTS ? threads : threads.filter((item) => item.projectKey === project), [project, threads]);
  const visibleThreads = useMemo(() => {
    if (project === ALL_PROJECTS) return projectThreads;
    const customer = customers.find((item) => item.id === customerId);
    return customer ? projectThreads.filter((thread) => customer.threadIds.includes(thread.id)) : projectThreads.filter((thread) => !customers.some((item) => item.threadIds.includes(thread.id)));
  }, [project, projectThreads, customerId, customers]);
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
  const dashboardCategories = useMemo(
    () => categories.filter((category) => filteredThreads.some((thread) => thread.category === category)),
    [categories, filteredThreads],
  );
  const displayedCategories = dashboardCategories;
  const projectStats = useMemo(() => {
    const stats: Record<string, { tasks: number; working: number }> = {
      [ALL_PROJECTS]: { tasks: threads.length, working: threads.filter((thread) => workingIds.has(thread.id)).length },
    };
    for (const item of projects) {
      const projectThreads = threads.filter((thread) => thread.projectKey === item.key);
      stats[item.key] = { tasks: projectThreads.length, working: projectThreads.filter((thread) => workingIds.has(thread.id)).length };
    }
    return stats;
  }, [projects, threads, workingIds]);
  const visibleWorkingCount = visibleThreads.filter((thread) => workingIds.has(thread.id)).length;
  const activeThread = threads.find((thread) => thread.id === activeId) ?? null;
  const chatThread = threads.find((thread) => thread.id === chatThreadId) ?? null;
  const movingThread = threads.find((thread) => thread.id === movingThreadId) ?? null;
  const forkingThread = threads.find((thread) => thread.id === forkingThreadId) ?? null;
  const renamingThread = threads.find((thread) => thread.id === renamingThreadId) ?? null;

  function retainCreatedThread(created: ThreadDto) {
    const retained = toBoardThreads([...threadsRef.current.filter((thread) => thread.id !== created.id), created]).find((thread) => thread.id === created.id);
    if (!retained) return;
    pendingThreadIdsRef.current.set(created.id, retained);
    setThreads((current) => toBoardThreads([...current.filter((thread) => thread.id !== created.id), created]));
    setChatThreadId(created.id);
  }
  function archiveConversation(threadId: string) {
    const thread = threadsRef.current.find((item) => item.id === threadId);
    if (thread) setArchiveDialog({ kind: "thread", threadId, title: thread.displayTitle });
  }

  function archiveCurrentProject(projectKey = project) {
    if (projectKey === ALL_PROJECTS) return;
    const projectThreads = threadsRef.current.filter((item) => item.projectKey === projectKey);
    if (!projectThreads.length) return;
    const label = projects.find((item) => item.key === projectKey)?.label || projectKey;
    setArchiveDialog({ kind: "project", projectKey, title: label, threadIds: projectThreads.map((thread) => thread.id) });
  }

  async function confirmArchive() {
    if (!archiveDialog) return;
    setArchiveBusy(true);
    try {
      if (archiveDialog.kind === "thread") {
        await archiveThread(archiveDialog.threadId);
        setChatThreadId((current) => current === archiveDialog.threadId ? null : current);
        setThreads((current) => current.filter((item) => item.id !== archiveDialog.threadId));
      } else {
        for (const threadId of archiveDialog.threadIds) await archiveThread(threadId);
        setChatThreadId(null);
      }
      setArchiveDialog(null);
      await refresh(true);
    } catch (cause) { setError(asCodexError(cause)); }
    finally { setArchiveBusy(false); }
  }
  async function renameConversation(title: string) {
    if (!renamingThread) return;
    const latest = await loadThread(renamingThread.id);
    const confirmed = await renameThread(renamingThread.id, threadNameWithTitle(latest.name || null, latest.preview || null, title));
    setThreads((current) => toBoardThreads(current.map((thread) => thread.id === confirmed.id ? confirmed : thread)));
  }

  async function createFork(category: string, title: string, lastTurnId: string | null) {
    if (!forkingThread) return;
    setForkBusy(true);
    try {
      const created = await forkThread(forkingThread.id, category, title, lastTurnId);
      setForkingThreadId(null);
      retainCreatedThread(created);
      await refresh(true);
    } finally {
      setForkBusy(false);
    }
  }


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

  async function sendOrQueue(threadId: string, message: string, _imageUrls?: string[], settings?: TurnSettings) {
    const wasWorking = workingIdsRef.current.has(threadId);
    if (!wasWorking) setThreadWorking(threadId, true);
    try {
      const selected: TurnSettings = { ...await turnPreferences.flush(), ...settings };
      if (!selected.model) throw new Error("Select a Codex model before sending a message.");
      const response = await sendMessage(threadId, message, _imageUrls, selected);
      if (response.queued) queueRevision.current += 1;
      const turnId = text(record(response.turn).id);
      if (turnId) setActiveTurns((current) => ({ ...current, [threadId]: turnId }));
    } catch (cause) {
      if (!wasWorking) setThreadWorking(threadId, false);
      throw cause;
    }
  }

  function removeQueuedMessage(threadId: string, messageId: string) {
    void removeQueuedMessageApi(threadId, messageId).then(() => { queueRevision.current += 1; }).catch((cause) => setError(asCodexError(cause)));
  }

  async function stopThread(threadId: string) {
    const turnId = activeTurns[threadId];
    if (!turnId) return;
    try {
      await interruptTurn(threadId, turnId);
    } catch (cause) {
      setError(asCodexError(cause));
    }
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
    if (!activeDragId.startsWith(THREAD_DRAG_PREFIX)) return;
    const threadId = activeDragId.slice(THREAD_DRAG_PREFIX.length);
    if (overId.startsWith(CATEGORY_DRAG_PREFIX)) {
      const targetCategory = categoryFromDragId(overId);
      await moveBoardThread(threadId, targetCategory);
      return;
    }
    if (overId.startsWith(CUSTOMER_DROP_PREFIX)) {
      const targetCustomer = customers.find((customer) => customer.id === customerFromDropId(overId));
      const targetThread = threads.find((thread) => thread.id === threadId);
      const normalizePath = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
      if (!targetCustomer || !targetThread || normalizePath(targetCustomer.projectCwd) !== normalizePath(targetThread.cwd || "")) return;
      assignThreadToCustomer(threadId, targetCustomer.id);
      return;
    }
    if (overId.startsWith(PROJECT_DROP_PREFIX)) {
      const targetProject = projectFromDropId(overId);
      const targetThread = threads.find((thread) => thread.id === threadId);
      const normalizePath = (path: string) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLocaleLowerCase();
      if (targetProject === ALL_PROJECTS || !targetThread || normalizePath(targetThread.cwd || "") !== targetProject) return;
      assignThreadToCustomer(threadId, null);
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
    <DndContext sensors={sensors} collisionDetection={(args) => {
      const pointerCollisions = pointerWithin(args);
      const customerTarget = pointerCollisions.find((collision) => String(collision.id).startsWith(CUSTOMER_DROP_PREFIX));
      return customerTarget ? [customerTarget] : pointerCollisions.length ? pointerCollisions : closestCenter(args);
    }} onDragStart={handleDragStart} onDragEnd={(event) => void handleDragEnd(event)}>
      <SortableContext items={displayedCategories.map(categoryDragId)} strategy={horizontalListSortingStrategy}>
        <BoardWorkspace
          project={project}
          customerId={customerId}
          customers={customers}
          search={search}
          projects={projects}
          projectStats={projectStats}
          displayedCategories={displayedCategories}
          filteredThreads={filteredThreads}
          visibleThreadCount={visibleThreads.length}
          workingCount={visibleWorkingCount}
          pendingIds={pendingIds}
          workingIds={workingIds}
          queues={queues}
          notifications={notifications}
          refreshing={refreshing}
          rateLimits={rateLimits}
          onProjectChange={selectProjectBoard}
          onCustomerChange={selectCustomerBoard}
          onCreateCustomer={setNewCustomerProjectKey}
          onAssignCustomer={assignThreadToCustomer}
          onSearchChange={setSearch}
          onRefresh={() => void refresh(true)}
          onCategories={() => setCategoryManager(true)}
          onAutomations={() => setAutomationsDialog(true)}
          onNewTask={() => setNewTaskDialog(true)}
          onNewProject={() => setNewProjectDialog(true)}
          onSettings={() => setSettingsOpen(true)}
          onGuide={() => setProductTour(true)}
          onInbox={() => { setInboxInitialTab("notifications"); setInboxOpen(true); }}
          onRemote={() => setRemoteDialog(true)}
          onOpen={setChatThreadId}
          onMove={setMovingThreadId}
          onFork={setForkingThreadId}
          onRenameThread={setRenamingThreadId}
          onDelete={archiveConversation}
          onStop={(threadId) => void stopThread(threadId)}
          onDeleteProject={(projectKey) => archiveCurrentProject(projectKey)}
          onDeleteCustomer={(customerId) => setCustomerToDelete(customers.find((customer) => customer.id === customerId) || null)}
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
          onFork={setForkingThreadId}
          onRename={setRenamingThreadId}
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
      {forkingThread && <ForkThreadDialog thread={forkingThread} categories={categories} busy={forkBusy} onClose={() => { if (!forkBusy) setForkingThreadId(null); }} onFork={createFork} />}
      {renamingThread && <RenameThreadDialog key={renamingThread.id} thread={renamingThread} onClose={()=>setRenamingThreadId(null)} onRename={renameConversation}/>}
      {settingsOpen && <BoardSettingsDialog approvalMode={approvalMode} onApprovalMode={setApprovalMode} onClose={() => setSettingsOpen(false)} />}
      {remoteDialog && <RemoteDialog onClose={() => setRemoteDialog(false)} />}
      {automationsDialog && <AutomationsDialog revision={automationRevision} threads={threads} categories={categories} onClose={() => setAutomationsDialog(false)} />}
      {newTaskDialog && <NewTaskDialog threads={threads} projects={projects.filter((item) => item.cwd)} categories={categories} defaultProjectKey={project === ALL_PROJECTS ? undefined : project} onClose={() => setNewTaskDialog(false)} onCreate={async (cwd, category, title, prompt, imageUrls) => { const created = await createThread(cwd, category, title, prompt, imageUrls); if (customerId) assignThreadToCustomer(created.id, customerId); retainCreatedThread(created); setNewTaskDialog(false); void refresh(true); }} />}
      {newProjectDialog && <NewProjectDialog existingPaths={projectPaths} onClose={() => setNewProjectDialog(false)} onCreate={createProject} />}
      {newCustomerProjectKey && <NewCustomerDialog projectLabel={projects.find((item) => item.key === newCustomerProjectKey)?.label || "Project"} existingNames={customers.filter((customer) => customer.projectCwd.replaceAll("\\", "/").toLocaleLowerCase() === (projects.find((item) => item.key === newCustomerProjectKey)?.cwd || "").replaceAll("\\", "/").toLocaleLowerCase()).map((customer) => customer.name)} onClose={() => setNewCustomerProjectKey(null)} onCreate={createCustomer} />}
      {productTour && <ProductTour onClose={() => { localStorage.setItem("codex-board.tour.v1", "done"); setProductTour(false); }} />}
      {inboxOpen && <InboxDialog items={notifications} initialTab={inboxInitialTab} onClose={()=>setInboxOpen(false)} onReadAll={()=>void markNotificationsRead().then(()=>listNotifications().then(setNotifications))} onClear={()=>void clearNotifications().then(()=>setNotifications([]))} onOpenResult={(item)=>{setInboxOpen(false);setResultNotification(item);if(!item.read)void markNotificationsRead(item.id);}} onOpen={(threadId)=>{setInboxOpen(false);setChatThreadId(threadId);const item=notifications.find(entry=>entry.threadId===threadId&&!entry.read);if(item)void markNotificationsRead(item.id);}} />}
      {resultNotification && <AutomationResultDialog notification={resultNotification} onClose={()=>setResultNotification(null)} onBackToList={()=>{setResultNotification(null);setInboxInitialTab("automations");setInboxOpen(true);}} onOpenThread={(threadId)=>{setResultNotification(null);setChatThreadId(threadId);}} />}
      {archiveDialog && <ConfirmArchiveDialog title={archiveDialog.kind === "thread" ? "Archive “" + archiveDialog.title + "”?" : "Archive project “" + archiveDialog.title + "”?"} description={archiveDialog.kind === "thread" ? "This removes the conversation from the active board while keeping its history safely in Codex archives." : "This archives " + archiveDialog.threadIds.length + " Codex conversation" + (archiveDialog.threadIds.length === 1 ? "" : "s") + ". Their history remains available in Codex archives."} confirmLabel={archiveDialog.kind === "thread" ? "Archive conversation" : "Archive project"} busy={archiveBusy} onCancel={() => { if (!archiveBusy) setArchiveDialog(null); }} onConfirm={() => void confirmArchive()} />}
      {customerToDelete && <ConfirmArchiveDialog title={`Delete customer “${customerToDelete.name}”?`} description="Assigned conversations will return to the project board. Their conversation history will not be deleted." confirmLabel="Delete customer" busyLabel="Deleting…" busy={customerDeleteBusy} onCancel={() => { if (!customerDeleteBusy) setCustomerToDelete(null); }} onConfirm={() => void confirmDeleteCustomer()} />}
      <aside className="toast-stack" aria-live="polite">
        {automationAlerts.map((item) => { const thread = item.threadId ? threadsRef.current.find((candidate) => candidate.id === item.threadId) : undefined; const projectLabel = thread?.projectLabel || "Codex Board"; return <button className="completion-toast automation-alert" key={item.id} onClick={()=>{setResultNotification(item);setAutomationAlerts((current)=>current.filter((entry)=>entry.id!==item.id));if(!item.read)void markNotificationsRead(item.id);}}><span className="toast-icon">⚡</span><span><strong>{projectLabel} · Automation completed</strong><small>{item.automation?.name}</small></span><i onClick={(event)=>{event.stopPropagation();setAutomationAlerts((current)=>current.filter((entry)=>entry.id!==item.id));}}>×</i></button>; })}
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
