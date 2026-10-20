import * as FileSystem from "expo-file-system/legacy";
import { ChatDraftStore, parseChatDraft, type DraftStorage } from "@codex-board/protocol";

export function createMobileDraftStorage(scope: string): DraftStorage {
  function directory(key: string) {
    if (!FileSystem.documentDirectory) throw new Error("Local draft storage unavailable");
    // Hex-only path segments keep paired URLs and thread IDs inside the app-private directory.
    const encoded = JSON.stringify([scope, key]).split("").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
    return FileSystem.documentDirectory + "chat-drafts-v1/" + encoded.match(/.{1,96}/g)!.join("/") + "/";
  }
  return {
    async read(key) {
      const dir = directory(key);
      let error: unknown;
      for (const name of ["draft.json", "draft.backup.json"]) {
        const path = dir + name;
        if (!(await FileSystem.getInfoAsync(path)).exists) continue;
        try { return parseChatDraft(JSON.parse(await FileSystem.readAsStringAsync(path))); }
        catch (cause) { error = cause; }
      }
      if (error) throw error;
      return null;
    },
    async write(key, draft) {
      const dir = directory(key);
      await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
      const destination = dir + "draft.json";
      const backup = dir + "draft.backup.json";
      const temporary = dir + "draft.pending.json";
      await FileSystem.writeAsStringAsync(temporary, JSON.stringify(draft));
      if ((await FileSystem.getInfoAsync(destination)).exists) {
        // Do not replace a valid backup with a corrupt main file recovered on load.
        let valid = false;
        try { parseChatDraft(JSON.parse(await FileSystem.readAsStringAsync(destination))); valid = true; }
        catch { /* retain the previous known-good backup */ }
        if (valid) await FileSystem.copyAsync({ from: destination, to: backup });
      }
      await FileSystem.moveAsync({ from: temporary, to: destination });
      if (!draft.text && draft.attachments.length === 0) await FileSystem.deleteAsync(backup, { idempotent: true });
    },
  };
}
export const createMobileDrafts = (scope: string) => new ChatDraftStore(createMobileDraftStorage(scope));
