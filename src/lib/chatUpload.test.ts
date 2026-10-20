import { afterEach, describe, expect, it, vi } from "vitest";
import { BoardApi } from "../../apps/mobile/src/api";
vi.mock("../../apps/mobile/src/connection", () => ({ loadLegacyTurnSettings: vi.fn(), saveLegacyTurnSettings: vi.fn() }));
afterEach(() => vi.unstubAllGlobals());
describe("mobile photo transport", () => {
  it("preserves full image data and model settings when forwarding a chat message", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ queued: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    const photos = ["data:image/jpeg;base64,AA==", "data:image/png;base64,BB=="];
    await new BoardApi({ baseUrl: "http://fixture", token: "fixture" }).send("chat", "Look", photos, { model: "selected" });
    const [, options] = fetch.mock.calls[0];
    expect(JSON.parse(options.body)).toMatchObject({ text: "Look", imageUrls: photos, settings: { model: "selected" } });
  });
  it("explains oversized photo requests rather than exposing an opaque HTTP error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 413 })));
    await expect(new BoardApi({ baseUrl: "http://fixture", token: "fixture" }).send("chat", "", ["data:image/jpeg;base64,AA=="]))
      .rejects.toThrow("Choose fewer or smaller images");
  });
});
