import { describe, expect, it } from "vitest";
import { forkTurnChoices } from "./ForkThreadDialog";

describe("forkTurnChoices", () => {
  it("offers completed turns and hides an active turn", () => {
    expect(forkTurnChoices([
      { id: "turn_1", status: "completed", items: [{ id: "u1", type: "userMessage", content: [{ type: "text", text: "Build the board" }] }] },
      { id: "turn_2", status: "interrupted", items: [{ id: "u2", type: "userMessage", content: "Review it" }] },
      { id: "turn_3", status: "inProgress", items: [{ id: "u3", type: "userMessage", content: "Still working" }] },
    ])).toEqual([
      { id: "turn_1", label: "Turn 1 · Build the board" },
      { id: "turn_2", label: "Turn 2 · Review it" },
    ]);
  });

  it("removes hidden automation metadata from labels", () => {
    const [choice] = forkTurnChoices([{ id: "turn_1", status: "completed", items: [{ type: "userMessage", content: "Check it\n<!-- codex-board-automation:abc -->" }] }]);
    expect(choice.label).toBe("Turn 1 · Check it");
  });
});
