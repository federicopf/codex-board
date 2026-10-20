import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMobileDraftStorage } from "../../apps/mobile/src/chatDrafts";
import * as FileSystem from "expo-file-system/legacy";

const files = vi.hoisted(() => new Map<string, string>());
vi.mock("expo-file-system/legacy", () => ({
  documentDirectory: "file:///private/",
  getInfoAsync: vi.fn(async (path: string) => ({ exists: files.has(path) })),
  readAsStringAsync: vi.fn(async (path: string) => { if (!files.has(path)) throw new Error("Not found"); return files.get(path)!; }),
  writeAsStringAsync: vi.fn(async (path: string, value: string) => { files.set(path, value); }),
  makeDirectoryAsync: vi.fn(async () => undefined),
  copyAsync: vi.fn(async ({from, to}: { from: string; to: string }) => { files.set(to, files.get(from)!); }),
  moveAsync: vi.fn(async ({from, to}: { from: string; to: string }) => { files.set(to, files.get(from)!); files.delete(from); }),
  deleteAsync: vi.fn(async (path: string) => { files.delete(path); }),
}));
beforeEach(() => { files.clear(); vi.clearAllMocks(); });
const draft = { text: "Photo draft", attachments: [{ id: "a", name: "Photo", dataUrl: "data:image/jpeg;base64,AA==", uri: "file:///cache/expired-photo" }] };
describe("mobile draft persistence", () => {
  it("restores self-contained image data after the original photo URI has expired", async () => {
    await createMobileDraftStorage("http://pc-a").write("thread", draft);
    expect(await createMobileDraftStorage("http://pc-a").read("thread")).toEqual(draft);
    expect(await createMobileDraftStorage("http://pc-b").read("thread")).toBeNull();
    expect(await createMobileDraftStorage("http://pc-a").read("other")).toBeNull();
  });
  it("recovers from a corrupt primary file using a valid backup", async () => {
    const storage = createMobileDraftStorage("pc");
    await storage.write("t", draft); await storage.write("t", { text: "New", attachments: [] });
    const primary = [...files.keys()].find(key => key.endsWith("/draft.json"))!;
    files.set(primary, "{broken");
    expect(await storage.read("t")).toEqual(draft);
  });
  it("retains the previous valid file if publishing the new draft fails", async () => {
    const storage = createMobileDraftStorage("pc"); await storage.write("t", draft);
    vi.mocked(FileSystem.moveAsync).mockRejectedValueOnce(new Error("Write failed"));
    await expect(storage.write("t", { text: "New", attachments: [] })).rejects.toThrow("Write failed");
    expect(await storage.read("t")).toEqual(draft);
  });
  it("does not retain a backup of sent content after clearing a draft", async () => {
    const storage = createMobileDraftStorage("pc"); await storage.write("t", draft);
    await storage.write("t", { text: "", attachments: [] });
    expect([...files.keys()].some(key => key.endsWith("/draft.backup.json"))).toBe(false);
    expect(await storage.read("t")).toEqual({ text: "", attachments: [] });
  });
  it("encodes URLs and thread IDs into path-safe segments inside app-private storage", async () => {
    await createMobileDraftStorage("http://pc/../secret").write("../../outside", draft);
    expect([...files.keys()].every(key => /^file:\/\/\/private\/chat-drafts-v1\/(?:[0-9a-f]+\/)+draft\.json$/.test(key))).toBe(true);
  });
});
