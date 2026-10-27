import type { BoardConfig, TurnSettings } from "./index";

export const defaultTurnSettings: TurnSettings = { model: "", effort: "", summary: "auto", serviceTier: "" };

export interface TurnSettingsSnapshot {
  settings: TurnSettings;
  ready: boolean;
  saving: boolean;
  error: string | null;
}

// Both clients use the same ordering rules. Catalog loading never clears a saved model.
export class TurnSettingsSync {
  private confirmed = { revision: -1, settings: defaultTurnSettings };
  private pending = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private listeners = new Set<() => void>();
  private snapshot: TurnSettingsSnapshot;

  constructor(private write: (patch: TurnSettings) => Promise<BoardConfig>, initial: TurnSettings = {}) {
    this.snapshot = { settings: { ...defaultTurnSettings, ...initial }, ready: false, saving: false, error: null };
  }

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };

  private publish(next: TurnSettingsSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }

  receive = (config: Pick<BoardConfig, "revision" | "turnSettings">) => {
    if (config.revision < this.confirmed.revision) return;
    this.confirmed = { revision: config.revision, settings: { ...defaultTurnSettings, ...config.turnSettings } };
    if (!this.pending) this.publish({ settings: this.confirmed.settings, ready: true, saving: false, error: null });
  };

  unavailable = (error: unknown) => {
    this.publish({ ...this.snapshot, error: error instanceof Error ? error.message : String(error) });
  };

  update = (patch: TurnSettings): Promise<void> => {
    this.pending++;
    this.publish({ ...this.snapshot, settings: { ...this.snapshot.settings, ...patch }, saving: true, error: null });
    const operation = this.tail.then(async () => { this.receive(await this.write(patch)); });
    const settled = operation.then(
      () => this.finish(null),
      (error: unknown) => { this.finish(error instanceof Error ? error.message : String(error)); throw error; },
    );
    this.tail = settled.catch(() => undefined);
    return settled;
  };

  private finish(error: string | null) {
    this.pending--;
    this.publish({
      settings: this.pending ? this.snapshot.settings : this.confirmed.settings,
      ready: this.confirmed.revision >= 0,
      saving: this.pending > 0,
      error,
    });
  }

  flush = async () => {
    while (this.pending) await this.tail;
    if (this.snapshot.error) throw new Error(this.snapshot.error);
    if (!this.snapshot.ready) throw new Error("Conversation settings are still loading.");
    return this.snapshot.settings;
  };
}

// The board preference is only a default. Each conversation owns its saved choice.
export class ThreadTurnSettingsSync {
  private readonly defaults: TurnSettingsSync;
  private readonly threads = new Map<string, TurnSettingsSync>();
  private config: Pick<BoardConfig, "revision" | "turnSettings" | "threadTurnSettings"> | null = null;

  constructor(writeDefault: (patch: TurnSettings) => Promise<BoardConfig>, private writeThread: (threadId: string, patch: TurnSettings) => Promise<BoardConfig>, initial: TurnSettings = {}) {
    this.defaults = new TurnSettingsSync(writeDefault, initial);
  }

  getSnapshot = () => this.defaults.getSnapshot();
  subscribe = (listener: () => void) => this.defaults.subscribe(listener);
  unavailable = (error: unknown) => {
    this.defaults.unavailable(error);
    for (const store of this.threads.values()) store.unavailable(error);
  };
  receive = (config: Pick<BoardConfig, "revision" | "turnSettings" | "threadTurnSettings">) => {
    if (this.config && config.revision < this.config.revision) return;
    this.config = config;
    this.defaults.receive(config);
    for (const [id, store] of this.threads) store.receive(this.threadConfig(id, config));
  };
  thread = (id: string): TurnSettingsSync => {
    let store = this.threads.get(id);
    if (!store) {
      store = new TurnSettingsSync(async (patch) => {
        const config = await this.writeThread(id, patch);
        this.receive(config);
        return { ...config, turnSettings: config.threadTurnSettings?.[id] ?? config.turnSettings };
      });
      this.threads.set(id, store);
      if (this.config) store.receive(this.threadConfig(id, this.config));
    }
    return store;
  };
  private threadConfig(id: string, config: Pick<BoardConfig, "revision" | "turnSettings" | "threadTurnSettings">) {
    return { revision: config.revision, turnSettings: config.threadTurnSettings?.[id] ?? config.turnSettings };
  }
}
