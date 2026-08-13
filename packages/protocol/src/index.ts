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

export type AutomationAction =
  | { kind: "recurringMessage"; threadId: string; prompt: string; everyMinutes: number; nextRunAt: number }
  | { kind: "categoryPipeline"; fromCategory: string; toCategory: string; afterMinutes: number };
export interface Automation { id: string; name: string; enabled: boolean; action: AutomationAction; lastRunAt: number | null; lastError: string | null; }
export type CreateAutomationInput =
  | { name: string; action: { kind: "recurringMessage"; threadId: string; prompt: string; everyMinutes: number; startInMinutes: number } }
  | { name: string; action: { kind: "categoryPipeline"; fromCategory: string; toCategory: string; afterMinutes: number } };

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
