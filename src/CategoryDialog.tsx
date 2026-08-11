import { useEffect, useState, type FormEvent } from "react";
import { categoryNameError } from "./lib/categoryOrder";

export function CategoryDialog({
  current,
  categories,
  busy,
  onCancel,
  onSubmit,
}: {
  current?: string;
  categories: string[];
  busy: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const [value, setValue] = useState(current || "");
  const [submitted, setSubmitted] = useState(false);
  const error = categoryNameError(value, categories, current);

  useEffect(() => setValue(current || ""), [current]);

  function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitted(true);
    if (!error) onSubmit(value.trim());
  }

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <form className="category-dialog" role="dialog" aria-modal="true" aria-labelledby="category-dialog-title" onSubmit={submit}>
        <h2 id="category-dialog-title">{current ? "Rename category" : "New category"}</h2>
        <p>Categories belong to this board. Cards keep syncing their title prefix with Codex.</p>
        <label>
          <span>Name</span>
          <input autoFocus value={value} disabled={busy} onChange={(event) => setValue(event.target.value)} />
        </label>
        {submitted && error && <div className="dialog-error" role="alert">{error}</div>}
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="submit" disabled={busy}>{busy ? "Saving…" : current ? "Rename" : "Create"}</button>
        </div>
      </form>
    </div>
  );
}
