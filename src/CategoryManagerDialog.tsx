import type { BoardThread } from "./types";

export function CategoryManagerDialog({ categories, threads, onClose, onCreate, onRename, onDelete, onPosition }: { categories: string[]; threads: BoardThread[]; onClose: () => void; onCreate: () => void; onRename: (category: string) => void; onDelete: (category: string) => void; onPosition: (category: string, position: number) => void }) {
  const counts = new Map(categories.map((category) => [category, threads.filter((thread) => thread.category === category).length]));
  return <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="category-manager-dialog" role="dialog" aria-modal="true" aria-labelledby="category-manager-title">
      <header><div><span className="eyebrow">Board structure</span><h2 id="category-manager-title">Manage categories</h2><p>Jump any category directly to a position, rename it, or remove empty ones.</p></div><button className="icon-button" onClick={onClose}>×</button></header>
      <div className="category-manager-list">{categories.map((category, index) => <article key={category}><span className="category-position">{index + 1}</span><div><strong>{category}</strong><small>{counts.get(category)} {counts.get(category) === 1 ? "task" : "tasks"}</small></div><label><span>Position</span><select value={index} onChange={(event) => onPosition(category, Number(event.target.value))}>{categories.map((_, position) => <option key={position} value={position}>{position + 1}</option>)}</select></label><button onClick={() => onPosition(category, 0)} disabled={index === 0}>First</button><button onClick={() => onPosition(category, categories.length - 1)} disabled={index === categories.length - 1}>Last</button><button onClick={() => onRename(category)}>Rename</button><button className="category-delete" disabled={Boolean(counts.get(category))} title={counts.get(category) ? "Move its tasks before deleting" : "Delete empty category"} onClick={() => onDelete(category)}>Delete</button></article>)}</div>
      <footer><button className="manager-create" onClick={onCreate}>＋ New category</button><button onClick={onClose}>Done</button></footer>
    </section>
  </div>;
}
