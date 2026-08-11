import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { CSSProperties, useCallback, useEffect, useMemo, useState } from "react";
import { asCodexError, listThreads, openThread, renameThread } from "./api";
import "./App.css";
import { moveThread, toBoardThreads } from "./lib/board";
import { ALL_PROJECTS, projectOptions, buildProjectMap } from "./lib/projects";
import { threadCategories } from "./lib/threadStatus";
import type { BoardThread, CodexError } from "./types";

function ThreadCard({
  thread,
  pending,
  showProject,
  onOpen,
  overlay = false,
}: {
  thread: BoardThread;
  pending: boolean;
  showProject: boolean;
  onOpen?: (threadId: string) => void;
  overlay?: boolean;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: thread.id,
    disabled: pending || overlay,
  });
  const style: CSSProperties | undefined = transform
    ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
    : undefined;

  return (
    <article
      ref={setNodeRef}
      style={style}
      className={`thread-card${isDragging ? " is-dragging" : ""}${overlay ? " overlay" : ""}`}
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
            Open ↗
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
  showProject,
  onOpen,
}: {
  category: string;
  threads: BoardThread[];
  pendingIds: Set<string>;
  showProject: boolean;
  onOpen: (threadId: string) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `column:${encodeURIComponent(category)}` });
  const hue = [...category].reduce((value, character) => value + character.charCodeAt(0), 0) % 360;
  return (
    <section ref={setNodeRef} className={`board-column${isOver ? " is-over" : ""}`}>
      <header className="column-header">
        <span className="status-dot" style={{ backgroundColor: `hsl(${hue} 55% 55%)` }} />
        <h2>{category}</h2>
        <span className="count">{threads.length}</span>
      </header>
      <div className="column-body">
        {threads.map((thread) => (
          <ThreadCard
            key={thread.id}
            thread={thread}
            pending={pendingIds.has(thread.id)}
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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<CodexError | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

  const refresh = useCallback(async (background = false) => {
    background ? setRefreshing(true) : setLoading(true);
    try {
      const result = await listThreads();
      setThreads(toBoardThreads(result));
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
  const categories = useMemo(
    () => threadCategories(visibleThreads.map((thread) => thread.category)),
    [visibleThreads],
  );
  const activeThread = threads.find((thread) => thread.id === activeId) ?? null;

  function handleDragStart(event: DragStartEvent) {
    setActiveId(String(event.active.id));
  }

  async function handleDragEnd(event: DragEndEvent) {
    setActiveId(null);
    const threadId = String(event.active.id);
    const overId = event.over ? String(event.over.id) : "";
    if (!overId.startsWith("column:") || pendingIds.has(threadId)) return;
    const targetCategory = decodeURIComponent(overId.slice("column:".length));
    const result = moveThread(threads, threadId, targetCategory);
    if (!result) return;

    setThreads(result.threads);
    setPendingIds((current) => new Set(current).add(threadId));
    try {
      await renameThread(threadId, result.newName);
      await refresh(true);
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

  async function handleOpen(threadId: string) {
    try {
      await openThread(threadId);
    } catch (cause) {
      setError(asCodexError(cause));
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
        <p>Install the standalone Codex CLI for Windows and make sure <code>codex</code> is available in PATH.</p>
        <button onClick={() => void refresh()}>Try again</button>
      </div>
    );
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={(event) => void handleDragEnd(event)}>
      <main className="app-shell">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark"><span /><span /><span /></div>
            <div><h1>Codex Board</h1><p>Threads, organized.</p></div>
          </div>
          <div className="toolbar">
            <label>
              <span>Project</span>
              <select value={project} onChange={(event) => setProject(event.target.value)}>
                <option value={ALL_PROJECTS}>All projects</option>
                {projects.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
              </select>
            </label>
            <button className="refresh-button" disabled={refreshing} onClick={() => void refresh(true)}>
              <span className={refreshing ? "spin" : ""}>↻</span> Refresh
            </button>
          </div>
        </header>

        {error && (
          <div className="error-banner" role="alert">
            <span>{error.message}</span>
            <button onClick={() => setError(null)} aria-label="Dismiss">×</button>
          </div>
        )}

        {visibleThreads.length === 0 ? (
          <div className="empty-board">
            <h2>No threads here yet</h2>
            <p>{project === ALL_PROJECTS ? "Your Codex threads will appear automatically." : "This project has no visible threads."}</p>
          </div>
        ) : (
          <div
            className="board"
            style={{ gridTemplateColumns: `repeat(${categories.length}, minmax(250px, 1fr))` }}
          >
            {categories.map((category) => (
              <Column
                key={category}
                category={category}
                threads={visibleThreads.filter((thread) => thread.category === category)}
                pendingIds={pendingIds}
                showProject={project === ALL_PROJECTS}
                onOpen={(threadId) => void handleOpen(threadId)}
              />
            ))}
          </div>
        )}
      </main>
      <DragOverlay>
        {activeThread ? <ThreadCard thread={activeThread} pending={false} showProject={project === ALL_PROJECTS} overlay /> : null}
      </DragOverlay>
    </DndContext>
  );
}

export default App;
