import type { ChatItem, ChatSession, CodexEvent, CodexThread, JsonValue } from "../types";

type JsonObject = Record<string, JsonValue>;

function object(value: JsonValue | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function string(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function textFrom(value: JsonValue | undefined): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFrom).filter(Boolean).join("\n");
  const item = object(value);
  return string(item.text) || string(item.content) || string(item.value);
}

function pretty(value: JsonValue | undefined): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function activityText(item: JsonObject, type: string): { title: string; text: string } {
  if (type === "commandExecution") {
    const command = string(item.command) || "Command";
    const output = string(item.aggregatedOutput);
    return { title: "Command", text: output ? `${command}\n\n${output}` : command };
  }
  if (type === "fileChange") {
    return { title: "File changes", text: pretty(item.changes) || "Preparing file changes…" };
  }
  if (type === "mcpToolCall") {
    const name = [string(item.server), string(item.tool)].filter(Boolean).join(" › ") || "MCP tool";
    return { title: name, text: pretty(item.result) || pretty(item.arguments) };
  }
  if (type === "dynamicToolCall") {
    return { title: string(item.tool) || "Tool", text: pretty(item.contentItems) || pretty(item.arguments) };
  }
  if (type === "webSearch") return { title: "Web search", text: string(item.query) };
  if (type === "imageView") return { title: "Image", text: string(item.path) };
  if (type === "contextCompaction") return { title: "Context", text: "Conversation context compacted" };
  return { title: type || "Activity", text: pretty(item) };
}

export function threadItemToChatItem(value: JsonValue): ChatItem | null {
  const item = object(value);
  const id = string(item.id);
  const type = string(item.type);
  if (!id || !type) return null;

  if (type === "userMessage") {
    return { id, kind: "user", text: textFrom(item.content) };
  }
  if (type === "agentMessage") {
    return { id, kind: "assistant", text: string(item.text) };
  }
  if (type === "plan") {
    return { id, kind: "plan", title: "Plan", text: string(item.text) };
  }
  if (type === "reasoning") {
    return { id, kind: "reasoning", title: "Reasoning", text: textFrom(item.summary) || textFrom(item.content) };
  }
  if (type === "enteredReviewMode" || type === "exitedReviewMode") {
    return { id, kind: "notice", title: "Review", text: string(item.review) };
  }

  const activity = activityText(item, type);
  return { id, kind: "activity", title: activity.title, text: activity.text, status: string(item.status) };
}

function turnItems(turn: JsonValue): JsonValue[] {
  const items = object(turn).items;
  return Array.isArray(items) ? items : [];
}

export function createChatSession(thread: CodexThread): ChatSession {
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  const items = turns.flatMap(turnItems).map(threadItemToChatItem).filter((item): item is ChatItem => item !== null);
  const activeTurn = [...turns].reverse().find((turn) => string(object(turn).status) === "inProgress");
  return {
    items,
    activeTurnId: activeTurn ? string(object(activeTurn).id) || null : null,
    running: Boolean(activeTurn),
  };
}

function upsert(items: ChatItem[], next: ChatItem): ChatItem[] {
  const index = items.findIndex((item) => item.id === next.id);
  if (index < 0) return [...items, next];
  const copy = [...items];
  copy[index] = next;
  return copy;
}

function appendDelta(items: ChatItem[], id: string, kind: ChatItem["kind"], delta: string, title?: string): ChatItem[] {
  if (!id || !delta) return items;
  const existing = items.find((item) => item.id === id);
  return upsert(items, {
    id,
    kind,
    title: existing?.title || title,
    text: `${existing?.text || ""}${delta}`,
    status: existing?.status,
  });
}

export function applyCodexEvent(state: ChatSession, event: CodexEvent, threadId: string): ChatSession {
  const params = object(event.params);
  const eventThreadId = string(params.threadId);
  if (eventThreadId && eventThreadId !== threadId) return state;

  if (event.method === "turn/started") {
    const turn = object(params.turn);
    return { ...state, running: true, activeTurnId: string(turn.id) || state.activeTurnId };
  }
  if (event.method === "turn/completed") {
    const turn = object(params.turn);
    let items = state.items;
    const error = object(turn.error);
    if (string(error.message)) {
      items = upsert(items, { id: `turn-error-${string(turn.id)}`, kind: "notice", title: "Turn failed", text: string(error.message), status: "failed" });
    }
    return { items, running: false, activeTurnId: null };
  }
  if (event.method === "item/started" || event.method === "item/completed") {
    const next = threadItemToChatItem(params.item);
    return next ? { ...state, items: upsert(state.items, next) } : state;
  }

  const itemId = string(params.itemId);
  const delta = string(params.delta);
  if (event.method === "item/agentMessage/delta") {
    return { ...state, items: appendDelta(state.items, itemId, "assistant", delta) };
  }
  if (event.method === "item/plan/delta") {
    return { ...state, items: appendDelta(state.items, itemId, "plan", delta, "Plan") };
  }
  if (event.method === "item/reasoning/summaryTextDelta" || event.method === "item/reasoning/textDelta") {
    return { ...state, items: appendDelta(state.items, itemId, "reasoning", delta, "Reasoning") };
  }
  if (event.method === "item/commandExecution/outputDelta" || event.method === "item/fileChange/outputDelta") {
    return { ...state, items: appendDelta(state.items, itemId, "activity", delta, event.method.includes("command") ? "Command" : "File changes") };
  }
  if (event.method === "error") {
    const error = object(params.error);
    const message = string(error.message) || "Codex encountered an error.";
    return { ...state, items: upsert(state.items, { id: `error-${string(params.turnId) || Date.now()}`, kind: "notice", title: "Codex error", text: message, status: "failed" }) };
  }
  return state;
}

export function eventRequest(event: CodexEvent, threadId: string) {
  if (event.requestId === undefined) return null;
  const params = object(event.params);
  if (string(params.threadId) !== threadId) return null;
  return { requestId: event.requestId, method: event.method, params };
}
