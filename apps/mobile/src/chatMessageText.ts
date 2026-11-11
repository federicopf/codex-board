import type { JsonValue } from "@codex-board/protocol";

export function chatMessageText(item: Record<string, JsonValue>): string {
  if (typeof item.text === "string" && item.text.length > 0) return item.text;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object" || Array.isArray(part)) return "";
    return typeof part.text === "string" ? part.text : "";
  }).filter(Boolean).join("\n");
}
