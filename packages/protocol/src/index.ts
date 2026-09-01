export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface ThreadDto {
  id: string;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  updatedAt: number | null;
  status?: JsonValue;
}

export interface BoardConfig {
  categories: string[];
  approvalMode: "auto" | "ask";
  revision: number;
}

export interface CodexEvent {
  method: string;
  params: JsonValue;
  requestId?: JsonValue;
}

export interface PairingCredential {
  baseUrl: string;
  token: string;
}

export interface RemoteHealth {
  ok: boolean;
  version: string;
}

export interface QueuedMessage { id: string; text: string; }
export interface SendOutcome { queued: boolean; messageId?: string | null; turn?: JsonValue; }
export interface PendingRemoteRequest { requestId: JsonValue; method: string; params: JsonValue; }
export interface CreateThreadInput { cwd: string; category: string; title: string; prompt: string; }
export interface AutomationResultDetails {
  id: string;
  name: string;
  result: string;
  status: "completed" | "failed" | "interrupted" | string;
  durationMs: number | null;
}
export interface BoardNotification {
  id: string;
  kind: "done" | "attention" | "error" | "automation";
  title: string;
  message: string;
  threadId: string | null;
  createdAt: number;
  read: boolean;
  automation?: AutomationResultDetails | null;
}

const directiveLabels: Record<string, string> = {
  "git-stage": "Stage changes",
  "git-commit": "Commit changes",
  "git-push": "Push changes",
};

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, "\\`")}\``;
}

export function formatCodexDirectives(value: string): string {
  return value.replace(/^::([\w-]+)\{([^}]*)\}\\?(?:&#x20;)?\s*$/gm, (_line, name: string, rawAttributes: string) => {
    const attributes = new Map<string, string>();
    for (const match of rawAttributes.matchAll(/([\w-]+)="([^"]*)"/g)) attributes.set(match[1], match[2]);
    const label = directiveLabels[name] || name.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
    const details = [
      attributes.get("cwd") && inlineCode(attributes.get("cwd")!),
      attributes.get("branch") && `branch ${inlineCode(attributes.get("branch")!)}`,
    ].filter(Boolean).join(" · ");
    return `- **${label}**${details ? ` — ${details}` : ""}`;
  });
}

export type AutomationAction =
    | { kind: "recurringMessage"; threadId: string; prompt: string; everyMinutes: number; nextRunAt: number }
    | { kind: "scheduledMessage"; threadId: string; prompt: string; runAt: number }
    | { kind: "calendarMessage"; threadId: string; prompt: string; weekdays: number[]; minuteOfDay: number; timezoneOffsetMinutes: number; nextRunAt: number }
    | { kind: "categoryPipeline"; fromCategory: string; toCategory: string; afterMinutes: number }
    | { kind: "scheduledCategoryPipeline"; fromCategory: string; toCategory: string; runAt: number };
export interface Automation { id: string; name: string; enabled: boolean; action: AutomationAction; lastRunAt: number | null; lastError: string | null; }
export type CreateAutomationInput =
    | { name: string; action: { kind: "recurringMessage"; threadId: string; prompt: string; everyMinutes: number; startInMinutes: number } }
    | { name: string; action: { kind: "scheduledMessage"; threadId: string; prompt: string; runAt: number } }
    | { name: string; action: { kind: "calendarMessage"; threadId: string; prompt: string; weekdays: number[]; minuteOfDay: number; timezoneOffsetMinutes: number } }
    | { name: string; action: { kind: "categoryPipeline"; fromCategory: string; toCategory: string; afterMinutes: number } }
    | { name: string; action: { kind: "scheduledCategoryPipeline"; fromCategory: string; toCategory: string; runAt: number } };

export function categoryFromTitle(name: string | null): string {
  if (!name) return "Uncategorized";
  const separator = name.indexOf(" - ");
  return separator > 0 ? name.slice(0, separator).trim() : "Uncategorized";
}

export function displayTitle(name: string | null, preview: string | null): string {
  if (!name) return preview || "Untitled task";
  const separator = name.indexOf(" - ");
  return separator > 0 ? name.slice(separator + 3).trim() || preview || name : name;
}

export function parsePairingPayload(value: string): PairingCredential {
  const parsed = value.trim().startsWith("{")
    ? JSON.parse(value) as Partial<PairingCredential>
    : (() => {
        const url = new URL(value);
        return { baseUrl: url.searchParams.get("url"), token: url.searchParams.get("token") };
      })();
  const baseUrl = parsed.baseUrl?.trim().replace(/\/$/, "");
  const token = parsed.token?.trim();
  if (!baseUrl || !/^https?:\/\//.test(baseUrl) || !token) throw new Error("Invalid Codex Board pairing code");
  return { baseUrl, token };
}
