import { describe, expect, it } from "vitest";
import { asCodexError, userFacingErrorMessage } from "./api";

describe("user-facing errors", () => {
  it("replaces the raw Windows missing-file message", () => {
    const message = userFacingErrorMessage("Impossibile trovare il file specificato. (os error 2)");
    expect(message).toContain("local file linked to this task");
    expect(message).not.toContain("os error 2");
  });

  it("normalizes structured Codex errors without losing their code", () => {
    expect(asCodexError({ code: "REQUEST_FAILED", message: "The system cannot find the file specified. (os error 2)" })).toMatchObject({
      code: "REQUEST_FAILED",
      message: expect.stringContaining("readable Codex history"),
    });
  });

  it("preserves unrelated messages", () => {
    expect(userFacingErrorMessage("Network unavailable")).toBe("Network unavailable");
  });
});
