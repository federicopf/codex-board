import * as FileSystem from "expo-file-system/legacy";
import type { JsonValue } from "@codex-board/protocol";

type CachedThread = Record<string, JsonValue>;
const PAGE_SIZE = 10;
const MAX_CACHE_BYTES = 512_000;

function safePathPart(value: string): string {
  return value.split("").map(char => char.charCodeAt(0).toString(16).padStart(4, "0")).join("");
}

function cachePath(scope: string, threadId: string): string {
  if (!FileSystem.documentDirectory) throw new Error("Local chat cache unavailable");
  return `${FileSystem.documentDirectory}chat-history-v1/${safePathPart(scope)}/${safePathPart(threadId)}.json`;
}

export async function readChatHistoryCache(scope: string, threadId: string): Promise<CachedThread | null> {
  try {
    const path = cachePath(scope, threadId);
    if (!(await FileSystem.getInfoAsync(path)).exists) return null;
    const value: unknown = JSON.parse(await FileSystem.readAsStringAsync(path));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const thread = value as CachedThread;
    if (!Array.isArray(thread.messages) || !thread.messages.length) return null;
    return thread;
  } catch {
    return null;
  }
}

export async function writeChatHistoryCache(scope: string, threadId: string, thread: CachedThread): Promise<void> {
  try {
    const path = cachePath(scope, threadId);
    const messages = Array.isArray(thread.messages) ? thread.messages.slice(-PAGE_SIZE) : [];
    const first = messages[0] && typeof messages[0] === "object" && !Array.isArray(messages[0])
      ? (messages[0] as Record<string, JsonValue>).index : undefined;
    const pagination = thread._pagination && typeof thread._pagination === "object" && !Array.isArray(thread._pagination)
      ? thread._pagination as Record<string, JsonValue> : {};
    const hasOlder = typeof first === "number" ? first > 0 : pagination.hasOlder === true;
    const cached: CachedThread = {
      id: thread.id,
      turns: [],
      messages,
      activeTurn: thread.activeTurn ?? null,
      _pagination: { ...pagination, ...(typeof first === "number" ? { start: first } : {}), hasOlder },
      _staleCache: true,
    };
    const serialized = JSON.stringify(cached);
    if (serialized.length > MAX_CACHE_BYTES) return;
    const directory = path.slice(0, path.lastIndexOf("/"));
    await FileSystem.makeDirectoryAsync(directory, { intermediates: true });
    const temporary = `${path}.pending`;
    await FileSystem.writeAsStringAsync(temporary, serialized);
    await FileSystem.moveAsync({ from: temporary, to: path });
  } catch {
    // Cache is an optimization; the server remains the source of truth.
  }
}
