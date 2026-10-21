import { useState } from "react";

export function NewCustomerDialog({ projectLabel, existingNames, onClose, onCreate }: {
  projectLabel: string;
  existingNames: string[];
  onClose: () => void;
  onCreate: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const normalized = name.trim().toLocaleLowerCase();
  const duplicate = existingNames.some((item) => item.trim().toLocaleLowerCase() === normalized);
  return <div className="dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <form className="new-task-dialog" onSubmit={(event) => { event.preventDefault(); if (normalized && !duplicate) onCreate(name.trim()); }}>
      <header><div><span className="eyebrow">{projectLabel}</span><h2>Add a customer</h2><p>Customer conversations stay separate from the project's general threads.</p></div><button type="button" className="icon-button" aria-label="Close" onClick={onClose}>×</button></header>
      <label><span>Customer name</span><input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Customer name" /></label>
      {duplicate && <p className="automation-form-error">A customer with this name already exists in this project.</p>}
      <footer><button type="button" onClick={onClose}>Cancel</button><button className="new-task-submit" disabled={!normalized || duplicate}>Create customer</button></footer>
    </form>
  </div>;
}
