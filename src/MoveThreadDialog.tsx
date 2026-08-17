import { useState } from "react";
import type { BoardThread } from "./types";
import { categoryNameError } from "./lib/categoryOrder";

export function MoveThreadDialog({ thread, categories, busy, onClose, onMove }: { thread: BoardThread; categories: string[]; busy: boolean; onClose: () => void; onMove: (category: string, create: boolean) => void }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const error = categoryNameError(name, categories);
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section className="move-thread-dialog" role="dialog" aria-modal="true" aria-labelledby="move-thread-title">
      <header><div><span className="eyebrow">Move task</span><h2 id="move-thread-title">Choose a category</h2><p>{thread.displayTitle}</p></div><button className="icon-button" disabled={busy} onClick={onClose}>×</button></header>
      {!creating ? <><div className="move-category-list">{categories.map((category) => <button key={category} disabled={busy || category === thread.category} className={category === thread.category ? "current" : ""} onClick={() => onMove(category, false)}><i /><span>{category}<small>{category === thread.category ? "Current category" : "Move here"}</small></span><b>{category === thread.category ? "✓" : "→"}</b></button>)}</div><button className="create-category-choice" onClick={() => setCreating(true)}>＋ Create a new category</button></> : <form onSubmit={(event) => { event.preventDefault(); if (!error) onMove(name.trim(), true); }}><label><span>New category name</span><input autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>{name && error && <p className="dialog-error">{error}</p>}<footer><button type="button" className="secondary" onClick={() => setCreating(false)}>Back</button><button type="submit" disabled={busy || Boolean(error)}>{busy ? "Moving…" : "Create and move"}</button></footer></form>}
    </section>
  </div>;
}
