import { useDraggable } from "@dnd-kit/core";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { CSSProperties } from "react";
import type { BoardNotification } from "@codex-board/protocol";
import type { ProjectInfo } from "./lib/projects";
import { ALL_PROJECTS } from "./lib/projects";
import type { BoardThread, QueuedMessage } from "./types";
import { Icon } from "./ui/Icon";

export const THREAD_DRAG_PREFIX = "thread:";
export const CATEGORY_DRAG_PREFIX = "category:";
export const ALL_STATUSES = "__all_statuses__";
export const threadDragId = (threadId: string) => `${THREAD_DRAG_PREFIX}${threadId}`;
export const categoryDragId = (category: string) => `${CATEGORY_DRAG_PREFIX}${encodeURIComponent(category)}`;
export const categoryFromDragId = (id: string) => decodeURIComponent(id.slice(CATEGORY_DRAG_PREFIX.length));

function BrandMark() {
  return <div className="brand-mark" aria-hidden="true"><span /><span /><span /></div>;
}

function updatedLabel(updatedAt: number | null): string {
  if (!updatedAt) return "Ready";
  const minutes = Math.max(0, Math.floor((Date.now() - updatedAt * 1000) / 60_000));
  if (minutes < 1) return "Updated now";
  if (minutes < 60) return `Updated ${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `Updated ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Updated ${days}d ago`;
}

function ThreadCard({ thread, pending, working, queuedCount, showProject, onOpen, onMove, overlay = false }: {
  thread: BoardThread;
  pending: boolean;
  working: boolean;
  queuedCount: number;
  showProject: boolean;
  onOpen?: (threadId: string) => void;
  onMove?: (threadId: string) => void;
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
    <article ref={setNodeRef} style={style} className={`thread-card${isDragging ? " is-dragging" : ""}${working ? " is-working" : ""}${overlay ? " overlay" : ""}`} {...listeners} {...attributes} aria-busy={pending}>
      <div className="card-topline">
        {showProject && <span className="project-chip">{thread.projectLabel}</span>}
        {working && <span className="card-working"><i />Working</span>}
        {!working && queuedCount > 0 && <span className="queue-count">{queuedCount} queued</span>}
      </div>
      <div className="card-title">{thread.displayTitle || "Untitled thread"}</div>
      {thread.preview && thread.preview.trim() !== thread.displayTitle && <div className="card-preview">{thread.preview}</div>}
      <footer>
        {pending ? <span className="saving">Saving changes…</span> : <span className="card-updated">{updatedLabel(thread.updatedAt)}</span>}
        {!overlay && <button className="card-icon-action" type="button" aria-label={`Move ${thread.displayTitle}`} title="Move task" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onMove?.(thread.id); }}><Icon name="move" /></button>}
        {!overlay && <button className="open-thread" type="button" onPointerDown={(event) => event.stopPropagation()} onClick={(event) => { event.stopPropagation(); onOpen?.(thread.id); }}><Icon name="message" /> Open</button>}
      </footer>
    </article>
  );
}

function BoardColumn({ category, threads, pendingIds, workingIds, queues, showProject, onOpen, onMove, onRename }: {
  category: string;
  threads: BoardThread[];
  pendingIds: Set<string>;
  workingIds: Set<string>;
  queues: Record<string, QueuedMessage[]>;
  showProject: boolean;
  onOpen: (threadId: string) => void;
  onMove: (threadId: string) => void;
  onRename: (category: string) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging, isOver } = useSortable({ id: categoryDragId(category) });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const hue = [...category].reduce((value, character) => value + character.charCodeAt(0), 0) % 360;
  return (
    <section ref={setNodeRef} style={style} className={`board-column${isOver ? " is-over" : ""}${isDragging ? " is-dragging-column" : ""}`}>
      <header className="column-header">
        <button className="column-drag-handle" type="button" aria-label={`Move ${category} column`} {...attributes} {...listeners}><Icon name="grip" /></button>
        <span className="status-dot" style={{ backgroundColor: `hsl(${hue} 55% 55%)` }} />
        <h2>{category}</h2>
        <span className="count">{threads.length}</span>
        <button className="column-rename" type="button" aria-label={`Rename ${category}`} title="Rename category" onClick={() => onRename(category)}><Icon name="edit" /></button>
      </header>
      <div className="column-body">
        {threads.map((thread) => <ThreadCard key={thread.id} thread={thread} pending={pendingIds.has(thread.id)} working={workingIds.has(thread.id)} queuedCount={queues[thread.id]?.length || 0} showProject={showProject} onOpen={onOpen} onMove={onMove} />)}
      </div>
    </section>
  );
}

export interface BoardWorkspaceProps {
  project: string;
  statusFilter: string;
  search: string;
  projects: ProjectInfo[];
  projectStats: Record<string, { tasks: number; working: number }>;
  populatedCategories: string[];
  displayedCategories: string[];
  filteredThreads: BoardThread[];
  visibleThreadCount: number;
  workingCount: number;
  pendingIds: Set<string>;
  workingIds: Set<string>;
  queues: Record<string, QueuedMessage[]>;
  notifications: BoardNotification[];
  refreshing: boolean;
  onProjectChange: (project: string) => void;
  onStatusChange: (status: string) => void;
  onSearchChange: (search: string) => void;
  onRefresh: () => void;
  onCategories: () => void;
  onAutomations: () => void;
  onNewTask: () => void;
  onSettings: () => void;
  onGuide: () => void;
  onInbox: () => void;
  onRemote: () => void;
  onOpen: (threadId: string) => void;
  onMove: (threadId: string) => void;
  onRename: (category: string) => void;
}

export function BoardWorkspace(props: BoardWorkspaceProps) {
  const projectLabel = props.project === ALL_PROJECTS ? "All projects" : props.projects.find((item) => item.key === props.project)?.label || "Project";
  const unread = props.notifications.filter((item) => !item.read).length;

  return (
    <main className="app-shell">
      <aside className="app-sidebar">
        <div className="sidebar-brand"><BrandMark /><div><strong>Codex Board</strong><span>Command center</span></div></div>
        <nav className="sidebar-nav" aria-label="Primary navigation">
          <button className="sidebar-link active"><Icon name="board" /><span>Board</span></button>
          <button className="sidebar-link" onClick={props.onAutomations}><Icon name="automations" /><span>Automations</span></button>
          <button className="sidebar-link" onClick={props.onInbox}><Icon name="bell" /><span>Inbox</span>{unread > 0 && <b>{unread}</b>}</button>
        </nav>
        <div className="sidebar-section-label">Project boards</div>
        <div className="sidebar-project-list" role="navigation" aria-label="Project boards">
          {[{ key: ALL_PROJECTS, label: "All projects" }, ...props.projects].map((item) => {
            const stats = props.projectStats[item.key] || { tasks: 0, working: 0 };
            return <button key={item.key} type="button" className={`sidebar-project${props.project === item.key ? " active" : ""}`} aria-current={props.project === item.key ? "page" : undefined} onClick={() => props.onProjectChange(item.key)}>
              <span>{item.key === ALL_PROJECTS ? "ALL" : item.label.slice(0, 2).toUpperCase()}</span>
              <div><strong>{item.label}</strong><small>{stats.tasks} {stats.tasks === 1 ? "task" : "tasks"}{stats.working > 0 ? ` · ${stats.working} working` : ""}</small></div>
              {stats.working > 0 && <i className="project-live-dot" aria-label={`${stats.working} working`} />}
            </button>;
          })}
        </div>
        <div className="sidebar-footer">
          <button className="sidebar-link remote-link" onClick={props.onRemote}><Icon name="remote" /><span>Remote access</span><i /></button>
          <button className="sidebar-link" onClick={props.onGuide}><Icon name="help" /><span>Quick guide</span></button>
          <button className="sidebar-link" onClick={props.onSettings}><Icon name="settings" /><span>Settings</span></button>
        </div>
      </aside>

      <section className="workspace-view">
        <header className="workspace-titlebar">
          <div><span className="eyebrow">Project board</span><h1>{projectLabel}</h1><p>{props.project === ALL_PROJECTS ? "A complete overview of work across every project." : "Move tasks through this project's workflow and continue any Codex conversation."}</p></div>
          <div className="titlebar-actions">
            <button className="button secondary" disabled={props.refreshing} onClick={props.onRefresh}><Icon name="refresh" className={props.refreshing ? "spin" : ""} /> Refresh</button>
            <button className="button secondary" onClick={props.onCategories}><Icon name="categories" /> Categories</button>
            <button className="button primary" onClick={props.onNewTask}><Icon name="plus" /> New task</button>
          </div>
        </header>

        <div className="workspace-commandbar">
          <div className="filter-group">
            <label className="select-control"><span>Status</span><select value={props.statusFilter} onChange={(event) => props.onStatusChange(event.target.value)}><option value={ALL_STATUSES}>All statuses</option>{props.populatedCategories.map((category) => <option key={category} value={category}>{category}</option>)}</select><Icon name="chevronDown" /></label>
          </div>
          <label className="search-control"><Icon name="search" /><input value={props.search} onChange={(event) => props.onSearchChange(event.target.value)} placeholder="Search tasks…" />{props.search && <button type="button" aria-label="Clear search" onClick={() => props.onSearchChange("")}>×</button>}</label>
          <div className="workspace-metrics"><span><strong>{props.visibleThreadCount}</strong> tasks</span><span className={props.workingCount ? "live" : ""}><i /><strong>{props.workingCount}</strong> working</span></div>
        </div>

        {props.displayedCategories.length === 0 ? (
          <div className="empty-board"><div className="empty-illustration"><Icon name="search" /></div><h2>No tasks match this board</h2><p>Change the status or search to see more work in this project.</p>{(props.search || props.statusFilter !== ALL_STATUSES) && <button className="button secondary" onClick={() => { props.onSearchChange(""); props.onStatusChange(ALL_STATUSES); }}>Clear filters</button>}</div>
        ) : (
          <div className="board" aria-label="Task board">
            {props.displayedCategories.map((category) => <BoardColumn key={category} category={category} threads={props.filteredThreads.filter((thread) => thread.category === category)} pendingIds={props.pendingIds} workingIds={props.workingIds} queues={props.queues} showProject={props.project === ALL_PROJECTS} onOpen={props.onOpen} onMove={props.onMove} onRename={props.onRename} />)}
          </div>
        )}
      </section>
    </main>
  );
}

export function ThreadDragOverlay({ thread, pending, working, queuedCount, showProject }: { thread: BoardThread; pending: boolean; working: boolean; queuedCount: number; showProject: boolean }) {
  return <ThreadCard thread={thread} pending={pending} working={working} queuedCount={queuedCount} showProject={showProject} overlay />;
}
