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
