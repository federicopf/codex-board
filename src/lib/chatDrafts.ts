import { ChatDraftStore, parseChatDraft, type DraftStorage } from "@codex-board/protocol";

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("codex-board-chat-drafts", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("drafts");
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("Draft database is blocked"));
    request.onsuccess = () => resolve(request.result);
  });
}
export const desktopDraftStorage: DraftStorage = {
  async read(key) {
    const db = await database();
    try {
      return await new Promise((resolve, reject) => {
        const request = db.transaction("drafts", "readonly").objectStore("drafts").get(key);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          try { resolve(request.result ? parseChatDraft(request.result) : null); }
          catch (error) { reject(error); }
        };
      });
    } finally { db.close(); }
  },
  async write(key, draft) {
    const db = await database();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction("drafts", "readwrite");
        transaction.objectStore("drafts").put(draft, key);
        transaction.oncomplete = () => resolve();
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally { db.close(); }
  },
};
export const desktopDrafts = new ChatDraftStore(desktopDraftStorage);
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => { void desktopDrafts.flushAll().catch(() => undefined); });
}
