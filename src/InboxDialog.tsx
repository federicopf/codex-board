import { useState } from "react";
import type { BoardNotification } from "@codex-board/protocol";

export function InboxDialog({items,onOpen,onOpenResult,onReadAll,onClear,onClose}:{items:BoardNotification[];onOpen:(id:string)=>void;onOpenResult:(item:BoardNotification)=>void;onReadAll:()=>void;onClear:()=>void;onClose:()=>void}) {
  const [tab, setTab] = useState<"notifications" | "automations">("notifications");
  const regular = items.filter((item) => !item.automation);
  const automations = items.filter((item) => Boolean(item.automation));
  const visible = tab === "automations" ? automations : regular;
  const unread = (values: BoardNotification[]) => values.filter((item) => !item.read).length;

  return <div className="dialog-backdrop" onMouseDown={e=>{if(e.target===e.currentTarget)onClose()}}><section className="inbox-dialog"><header><div><span className="eyebrow">Attention center</span><h2>Inbox</h2><p>Notifications and automation results, kept separate.</p></div><button className="icon-button" aria-label="Close" onClick={onClose}>×</button></header><div className="inbox-tabs" role="tablist"><button className={tab === "notifications" ? "active" : ""} role="tab" aria-selected={tab === "notifications"} onClick={() => setTab("notifications")}>Notifications {unread(regular) > 0 && <b>{unread(regular)}</b>}</button><button className={tab === "automations" ? "active" : ""} role="tab" aria-selected={tab === "automations"} onClick={() => setTab("automations")}>Automations {unread(automations) > 0 && <b>{unread(automations)}</b>}</button></div><div className="inbox-actions"><button onClick={onReadAll}>Mark all read</button><button onClick={onClear}>Clear all</button></div><div className="inbox-list">{visible.length===0&&<div className="automation-empty">{tab === "automations" ? "No automation results yet." : "You're all caught up."}</div>}{visible.map(item=><button key={item.id} className={`inbox-item ${item.kind}${item.read?" read":""}`} onClick={()=>item.automation?onOpenResult(item):item.threadId&&onOpen(item.threadId)}><i/><span><strong>{item.title}</strong><p>{item.automation?.name||item.message}</p>{item.automation&&<small>View quick result</small>}</span><time>{new Date(item.createdAt).toLocaleString()}</time></button>)}</div></section></div>;
}
