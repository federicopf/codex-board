import { useState } from "react";
import { automationOutcome, groupAutomationNotifications } from "@codex-board/protocol";
import type { BoardNotification, ProjectCustomer } from "@codex-board/protocol";
import type { BoardThread } from "./types";

export function InboxDialog({ items, threads = [], customers = [], onOpen, onOpenResult, onReadAll, onClear, onClose, initialTab = "notifications" }: {
  items: BoardNotification[];
  threads?: BoardThread[];
  customers?: ProjectCustomer[];
  onOpen: (id: string) => void;
  onOpenResult: (item: BoardNotification) => void;
  onReadAll: () => void;
  onClear: () => void;
  onClose: () => void;
  initialTab?: "notifications" | "automations";
}) {
  const [tab, setTab] = useState<"notifications" | "automations">(initialTab);
  const regular = items.filter((item) => !item.automation).sort((a, b) => b.createdAt - a.createdAt);
  const automations = items.filter((item) => Boolean(item.automation));
  const threadById = new Map(threads.map((thread) => [thread.id, thread]));
  const groups = groupAutomationNotifications(automations, (id) => {
    const thread = threadById.get(id);
    if (!thread) return null;
    const customer = customers.find((item) => item.threadIds.includes(id));
    return { projectKey: thread.projectKey, projectLabel: thread.projectLabel, taskLabel: thread.displayTitle, customerName: customer?.name };
  });
  const unread = (values: BoardNotification[]) => values.filter((item) => !item.read).length;

  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="inbox-dialog"><header><div><span className="eyebrow">Attention center</span><h2>Inbox</h2><p>Notifications and automation results, kept separate.</p></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></header>
    <div className="inbox-tabs" role="tablist"><button className={tab === "notifications" ? "active" : ""} role="tab" aria-selected={tab === "notifications"} onClick={() => setTab("notifications")}>Notifications {unread(regular) > 0 && <b>{unread(regular)}</b>}</button><button className={tab === "automations" ? "active" : ""} role="tab" aria-selected={tab === "automations"} onClick={() => setTab("automations")}>Automations {unread(automations) > 0 && <b>{unread(automations)}</b>}</button></div>
    <div className="inbox-actions"><button onClick={onReadAll}>Mark all read</button><button onClick={onClear}>Clear all</button></div>
    <div className="inbox-list">
      {tab === "automations" ? groups.length ? groups.map((group) => <section className="inbox-project-group" key={group.key}><h3>{group.label}<small>{group.items.length}</small></h3>{group.items.map(({ notification, context }) => {
        const result = notification.automation!;
        const outcome = automationOutcome(result.status);
        return <button key={notification.id} className={`inbox-item automation${notification.read ? " read" : ""}`} aria-label={`${result.name}, ${group.label}, ${context.taskLabel}, ${outcome.label}`} onClick={() => onOpenResult(notification)}>
          <span className="inbox-item-main"><strong>{result.name}</strong><span className="inbox-context">{context.customerName ? `${context.customerName} · ` : ""}{context.taskLabel}</span><span className="inbox-result-summary">{result.result}</span></span>
          <span className="inbox-item-meta"><span className={`automation-outcome ${outcome.tone}`}>{outcome.label}</span><time>{new Date(notification.createdAt).toLocaleString()}</time></span>
        </button>;
      })}</section>) : <div className="automation-empty">No automation results yet.</div> : regular.length ? regular.map((item) => <button key={item.id} className={`inbox-item ${item.kind}${item.read ? " read" : ""}`} onClick={() => item.threadId && onOpen(item.threadId)}><i/><span><strong>{item.title}</strong><p>{item.message}</p></span><time>{new Date(item.createdAt).toLocaleString()}</time></button>) : <div className="automation-empty">You're all caught up.</div>}
    </div>
  </section></div>;
}
