export interface ThreadDto {
  id: string;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  updatedAt: number | null;
  status?: JsonValue;
}

export interface CodexError {
  code:
    | "CLI_NOT_FOUND"
    | "START_FAILED"
    | "HANDSHAKE_FAILED"
    | "PROTOCOL_ERROR"
    | "REQUEST_FAILED"
    | "PROCESS_EXITED";
  message: string;
  details?: string | null;
}

export interface BoardThread extends ThreadDto {
  category: string;
  displayTitle: string;
  effectiveTitle: string;
  projectKey: string;
  projectLabel: string;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface CodexThread {
  id: string;
  name?: string | null;
  preview?: string | null;
  cwd?: string | null;
  turns?: JsonValue[];
  status?: JsonValue;
}

export interface CodexEvent {
  method: string;
  params: JsonValue;
  requestId?: JsonValue;
}

export interface SequencedCodexEvent {
  sequence: number;
  event: CodexEvent;
}

export interface QueuedMessage {
  id: string;
  text: string;
}

export type ChatItemKind = "user" | "assistant" | "reasoning" | "plan" | "activity" | "notice";

export interface ChatItem {
  id: string;
  kind: ChatItemKind;
  title?: string;
  text: string;
  status?: string;
}

export interface ChatSession {
  items: ChatItem[];
  activeTurnId: string | null;
  running: boolean;
}

export interface PendingCodexRequest {
  requestId: JsonValue;
  method: string;
  params: Record<string, JsonValue>;
}
