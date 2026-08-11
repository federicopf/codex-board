import { describe, expect, it } from "vitest";
import { approvalResult, denialResult } from "./approvals";

describe("approval responses", () => {
  it("uses current protocol decisions", () => {
    expect(approvalResult({ method: "item/commandExecution/requestApproval", params: {} }, true))
      .toEqual({ decision: "acceptForSession" });
    expect(denialResult({ method: "item/fileChange/requestApproval" }))
      .toEqual({ decision: "decline" });
  });

  it("supports legacy approval requests", () => {
    expect(approvalResult({ method: "applyPatchApproval", params: {} }, true))
      .toEqual({ decision: "approved_for_session" });
    expect(denialResult({ method: "execCommandApproval" }))
      .toEqual({ decision: { denied: { rejection: "Denied by user" } } });
  });

  it("grants exactly the requested permission profile", () => {
    const permissions = { network: { enabled: true } };
    expect(approvalResult({ method: "item/permissions/requestApproval", params: { permissions } }, true))
      .toEqual({ permissions, scope: "session" });
  });

  it("does not auto-answer questions or MCP forms", () => {
    expect(approvalResult({ method: "item/tool/requestUserInput", params: {} }, true)).toBeNull();
    expect(approvalResult({ method: "mcpServer/elicitation/request", params: {} }, true)).toBeNull();
  });
});
