import { describe, expect, it } from "vitest";
import { chatMessageText } from "../../apps/mobile/src/chatMessageText";

describe("mobile chat message text", () => {
  it("reads current Codex agent messages from content parts", () => {
    expect(chatMessageText({ type: "agentMessage", content: [{ type: "text", text: "Prima risposta" }, { type: "text", text: "Seconda parte" }] })).toBe("Prima risposta\nSeconda parte");
  });

  it("keeps user messages and legacy agent text visible", () => {
    expect(chatMessageText({ type: "userMessage", content: [{ type: "text", text: "Ciao" }] })).toBe("Ciao");
    expect(chatMessageText({ type: "agentMessage", text: "Risposta precedente" })).toBe("Risposta precedente");
  });

  it("ignores non-text attachment parts without replacing valid text", () => {
    expect(chatMessageText({ content: [{ type: "image", url: "[omitted]" }, { type: "text", text: "Guarda questa foto" }] })).toBe("Guarda questa foto");
  });
});
