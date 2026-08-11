export interface ThreadDto {
  id: string;
  name: string | null;
  preview: string | null;
  cwd: string | null;
  updatedAt: number | null;
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
