import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDraftStore, parseChatDraft, type ChatDraft, type DraftStorage } from "@codex-board/protocol";

const photo = { id: "photo", name: "Photo", dataUrl: "data:image/jpeg;base64,AA==" };
const stores: ChatDraftStore[] = [];
function fixture() {
  const saved = new Map<string, ChatDraft>();
  const storage: DraftStorage = { read: vi.fn(async key => saved.get(key) || null), write: vi.fn(async (key, draft) => { saved.set(key, structuredClone(draft)); }) };
  const store = new ChatDraftStore(storage, 60_000); stores.push(store);
  return { store, saved, storage };
}
afterEach(async () => { await Promise.all(stores.splice(0).map(store => store.flushAll().catch(() => undefined))); });
describe("client-local conversation drafts", () => {
  it("retains text and photos independently for each conversation and restores after restarting the store", async () => {
    const { store, storage } = fixture();
    await store.load("a"); await store.load("b");
    store.update("a", () => ({ text: "Unsent text", attachments: [photo] }));
    store.update("b", () => ({ text: "Other thread", attachments: [] }));
    await store.flushAll();
    const reopened = new ChatDraftStore(storage); stores.push(reopened);
    await reopened.load("a"); await reopened.load("b");
    expect(reopened.getSnapshot("a").draft).toEqual({ text: "Unsent text", attachments: [photo] });
    expect(reopened.getSnapshot("b").draft.text).toBe("Other thread");
  });
  it("does not overwrite fresh typing with a slow storage read", async () => {
    let resolve!: (value: ChatDraft) => void;
    const { storage } = fixture();
    storage.read = () => new Promise(done => { resolve = done; });
    const store = new ChatDraftStore(storage, 60_000); stores.push(store);
    const loading = store.load("a");
    store.update("a", () => ({ text: "New typing", attachments: [] }));
    resolve({ text: "Old disk content", attachments: [photo] });
    await loading;
    expect(store.getSnapshot("a").draft.text).toBe("New typing");
  });
  it("clears only accepted content, preserving edits made while the request was pending", async () => {
    const { store } = fixture(); await store.load("a");
    store.update("a", () => ({ text: "First message", attachments: [photo] }));
    const sent = store.getSnapshot("a").draft;
    const extra = { ...photo, id: "extra" };
    store.update("a", () => ({ text: "Still writing", attachments: [photo, extra] }));
    store.accepted("a", sent); await store.flush("a");
    expect(store.getSnapshot("a").draft).toEqual({ text: "Still writing", attachments: [extra] });
  });
  it("persists an empty draft after a confirmed send, without resurrecting it on reopen", async () => {
    const { store, storage } = fixture(); await store.load("a");
    store.update("a", () => ({ text: "Ready", attachments: [photo] }));
    await store.flush("a");
    store.accepted("a", store.getSnapshot("a").draft); await store.flush("a");
    const reopened = new ChatDraftStore(storage); stores.push(reopened); await reopened.load("a");
    expect(reopened.getSnapshot("a").draft).toEqual({ text: "", attachments: [] });
  });
  it("serializes writes so an older slow save cannot replace a newer save", async () => {
    const { store, saved, storage } = fixture(); await store.load("a");
    let release!: () => void;
    let first = true;
    storage.write = async (key, draft) => {
      if (first) { first = false; await new Promise<void>(done => { release = done; }); }
      saved.set(key, draft);
    };
    store.update("a", () => ({ text: "Old", attachments: [] }));
    const writing = store.flush("a"); await Promise.resolve(); await Promise.resolve();
    store.update("a", () => ({ text: "New", attachments: [] }));
    const newer = store.flush("a");
    release(); await writing; await newer;
    expect(saved.get("a")?.text).toBe("New");
  });
  it("keeps the in-memory draft visible when device persistence fails and can retry saving", async () => {
    const { store, storage } = fixture(); await store.load("a");
    vi.mocked(storage.write).mockRejectedValueOnce(new Error("Disk full"));
    store.update("a", () => ({ text: "Do not lose this", attachments: [photo] }));
    await expect(store.flush("a")).rejects.toThrow("Disk full");
    expect(store.getSnapshot("a").draft.text).toBe("Do not lose this");
    expect(store.getSnapshot("a").error).toContain("kept in memory");
    await store.flush("a");
    expect(store.getSnapshot("a").error).toBeNull();
  });
  it("rejects corrupt drafts instead of silently deleting photos or pretending restoration succeeded", () => {
    expect(() => parseChatDraft({ text: "Draft", attachments: [{}] })).toThrow();
    expect(() => parseChatDraft({})).toThrow();
  });
});
