import { afterEach, describe, expect, it, vi } from "vitest";
import { automationOutcome } from "@codex-board/protocol";
import { BoardApi } from "../../apps/mobile/src/api";
vi.mock("../../apps/mobile/src/connection", () => ({ loadLegacyTurnSettings: vi.fn(), saveLegacyTurnSettings: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
describe("automation outcome contract", () => {
  it.each(["completed", "unknown", "", "inProgress", undefined])("does not confuse %s with task success", status => {
    expect(automationOutcome(status)).toMatchObject({ tone: "unknown", retryable: true });
  });
  it("recognizes success, business failures and interruption", () => {
    expect(automationOutcome("success")).toMatchObject({ label: "Success", tone: "success", retryable: false });
    expect(automationOutcome("failed")).toMatchObject({ label: "Failed", tone: "failed", retryable: true });
    expect(automationOutcome("interrupted")).toMatchObject({ label: "Failed", tone: "failed", retryable: true });
  });
  it("retries through the authenticated backend without recreating or editing the workflow", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await new BoardApi({ baseUrl: "http://fixture", token: "test" }).retryAutomation("a/1");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("http://fixture/v1/automations/a%2F1/retry",
      expect.objectContaining({ method: "POST", headers: expect.objectContaining({ Authorization: "Bearer test" }) }));
  });
  it("explains a missing backend capability without sending fallback turns", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetch);
    await expect(new BoardApi({ baseUrl: "http://fixture", token: "test" }).retryAutomation("a")).rejects.toThrow("Aggiorna Codex Board sul PC");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
