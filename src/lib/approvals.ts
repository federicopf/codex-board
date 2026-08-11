import type { JsonValue, PendingCodexRequest } from "../types";

export type ApprovalMode = "ask" | "auto";
export const APPROVAL_MODE_STORAGE_KEY = "codex-board.approval-mode.v1";

export function loadApprovalMode(): ApprovalMode {
  return localStorage.getItem(APPROVAL_MODE_STORAGE_KEY) === "ask" ? "ask" : "auto";
}

export function saveApprovalMode(mode: ApprovalMode): void {
  localStorage.setItem(APPROVAL_MODE_STORAGE_KEY, mode);
}

export function approvalResult(request: Pick<PendingCodexRequest, "method" | "params">, forSession = false): JsonValue | null {
  const { method, params } = request;
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { decision: forSession ? "acceptForSession" : "accept" };
  }
  if (method === "item/permissions/requestApproval") {
    return { permissions: params.permissions || {}, scope: forSession ? "session" : "turn" };
  }
  if (method === "applyPatchApproval" || method === "execCommandApproval") {
    return { decision: forSession ? "approved_for_session" : "approved" };
  }
  return null;
}

export function denialResult(request: Pick<PendingCodexRequest, "method">): JsonValue | null {
  if (request.method === "item/commandExecution/requestApproval" || request.method === "item/fileChange/requestApproval") {
    return { decision: "decline" };
  }
  if (request.method === "item/permissions/requestApproval") {
    return { permissions: {}, scope: "turn" };
  }
  if (request.method === "applyPatchApproval" || request.method === "execCommandApproval") {
    return { decision: { denied: { rejection: "Denied by user" } } };
  }
  return null;
}
