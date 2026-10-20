export interface DraftAttachment { id: string; name: string; dataUrl: string; uri?: string; }
export interface ChatDraft { text: string; attachments: DraftAttachment[]; }
export interface DraftSnapshot { draft: ChatDraft; ready: boolean; error: string | null; }
export interface DraftStorage {
  read(key: string): Promise<ChatDraft | null>;
  write(key: string, draft: ChatDraft): Promise<void>;
}
interface Entry {
  snapshot: DraftSnapshot; revision: number; dirty: boolean; writing: boolean;
  loading?: Promise<void>; tail: Promise<void>;
  timer?: ReturnType<typeof setTimeout>; listeners: Set<() => void>;
}
export function parseChatDraft(value: unknown): ChatDraft {
  if (!value || typeof value !== "object") throw new Error("Invalid saved draft");
  const data = value as Record<string, unknown>;
  if (typeof data.text !== "string" || !Array.isArray(data.attachments)) throw new Error("Invalid saved draft");
  const attachments = data.attachments.map((item: unknown): DraftAttachment => {
    if (!item || typeof item !== "object") throw new Error("Invalid draft attachment");
    const a = item as Record<string, unknown>;
    if (typeof a.id !== "string" || typeof a.name !== "string" || typeof a.dataUrl !== "string") throw new Error("Invalid draft attachment");
    return { id: a.id, name: a.name, dataUrl: a.dataUrl, ...(typeof a.uri === "string" ? { uri: a.uri } : {}) };
  });
  return { text: data.text, attachments };
}

/** Client-local drafts, independent of mounted chat screens and the backend execution queue. */
export class ChatDraftStore {
  private entries = new Map<string, Entry>();
  constructor(private storage: DraftStorage, private delayMs = 300) {}
  private entry(key: string): Entry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { snapshot: { draft: { text: "", attachments: [] }, ready: false, error: null }, revision: 0, dirty: false, writing: false, tail: Promise.resolve(), listeners: new Set() };
      this.entries.set(key, entry);
    }
    return entry;
  }
  getSnapshot = (key: string) => this.entry(key).snapshot;
  subscribe = (key: string, listener: () => void) => {
    const entry = this.entry(key); entry.listeners.add(listener);
    return () => { entry.listeners.delete(listener); };
  };
  private publish(entry: Entry, snapshot: DraftSnapshot) {
    entry.snapshot = snapshot;
    for (const listener of entry.listeners) listener();
  }
  load(key: string): Promise<void> {
    const entry = this.entry(key);
    if (!entry.loading) {
      const revision = entry.revision;
      entry.loading = this.storage.read(key).then(saved => {
        this.publish(entry, { draft: revision === entry.revision && saved ? parseChatDraft(saved) : entry.snapshot.draft, ready: true, error: null });
      }).catch(() => {
        this.publish(entry, { ...entry.snapshot, ready: true, error: "Could not restore the saved draft. New edits remain in this session." });
      });
    }
    return entry.loading;
  }
  update(key: string, change: (draft: ChatDraft) => ChatDraft) {
    const entry = this.entry(key);
    entry.revision++; entry.dirty = true;
    this.publish(entry, { ...entry.snapshot, draft: change(entry.snapshot.draft) });
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { void this.flush(key).catch(() => undefined); }, this.delayMs);
  }
  /** Remove only what the backend accepted, preserving text/photos added while sending. */
  accepted(key: string, submitted: ChatDraft) {
    const sent = new Set(submitted.attachments.map(item => item.id));
    this.update(key, current => ({
      text: current.text === submitted.text ? "" : current.text,
      attachments: current.attachments.filter(item => !sent.has(item.id)),
    }));
    void this.flush(key).catch(() => undefined);
  }
  flush(key: string): Promise<void> {
    const entry = this.entry(key);
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = undefined; }
    if (!entry.dirty || entry.writing) return entry.tail;
    entry.writing = true;
    entry.tail = entry.tail.catch(() => undefined).then(async () => {
      // Coalesce edits made during a slow disk write instead of queuing every intermediate draft.
      while (entry.dirty) {
        entry.dirty = false;
        const { draft } = entry.snapshot;
        const revision = entry.revision;
        await this.storage.write(key, draft);
        if (entry.revision === revision) this.publish(entry, { ...entry.snapshot, error: null });
      }
    }).catch(error => {
        entry.dirty = true;
        this.publish(entry, { ...entry.snapshot, error: "Draft is kept in memory, but could not be saved on this device." });
        throw error;
      }).finally(() => { entry.writing = false; });
    return entry.tail;
  }
  async flushAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map(key => this.flush(key)));
  }
}
