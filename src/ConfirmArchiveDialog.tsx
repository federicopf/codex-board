import { Icon } from "./ui/Icon";

export function ConfirmArchiveDialog({
  title,
  description,
  confirmLabel,
  busy,
  onCancel,
  onConfirm,
}: {
  title: string;
  description: string;
  confirmLabel: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <div className="dialog-backdrop archive-confirm-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !busy) onCancel();
    }}>
      <section className="archive-confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="archive-confirm-title" aria-describedby="archive-confirm-description">
        <div className="archive-confirm-icon"><Icon name="trash" /></div>
        <h2 id="archive-confirm-title">{title}</h2>
        <p id="archive-confirm-description">{description}</p>
        <div className="dialog-actions">
          <button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button>
          <button type="button" className="archive-confirm-button" disabled={busy} onClick={onConfirm}>{busy ? "Archiving…" : confirmLabel}</button>
        </div>
      </section>
    </div>
  );
}
