import type { JsonValue } from "@codex-board/protocol";
import { chatMessageText } from "./chatMessageText";

export interface PendingChatMessage {
  id: string;
  text: string;
  imageCount: number;
  afterIndex: number;
  accepted: boolean;
}

export function reconcilePendingChatMessages(pending: PendingChatMessage[], thread: Record<string, JsonValue>): PendingChatMessage[] {
  if (!pending.length || !Array.isArray(thread.messages)) return pending;
  const pagination = thread._pagination && typeof thread._pagination === "object" && !Array.isArray(thread._pagination)
    ? thread._pagination as Record<string, JsonValue> : {};
  const start = typeof pagination.start === "number" ? pagination.start : 0;
  const received = thread.messages.flatMap((raw, position) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
    const message = raw as Record<string, JsonValue>;
    const item = message.item;
    if (!item || typeof item !== "object" || Array.isArray(item) || item.type !== "userMessage") return [];
    return [{ index: typeof message.index === "number" ? message.index : start + position, text: chatMessageText(item).trimEnd() }];
  });
  return pending.filter((message) => {
    if (!message.accepted) return true;
    const match = received.findIndex((item) => item.index >= message.afterIndex && item.text === message.text);
    if (match < 0) return true;
    received.splice(match, 1);
    return false;
  });
}
