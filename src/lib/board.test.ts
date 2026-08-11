import { describe, expect, it } from "vitest";
import { moveThread, toBoardThreads } from "./board";
import { UNCATEGORIZED } from "./threadStatus";

const original = toBoardThreads([
  { id: "1", name: "To Plan - Build", preview: "Build", cwd: "C:\\work", updatedAt: 1 },
]);

describe("optimistic board updates", () => {
  it("moves and builds a real thread name", () => {
    const result = moveThread(original, "1", "WIP");
    expect(result?.updated.category).toBe("WIP");
    expect(result?.newName).toBe("WIP - Build");
  });

  it("does nothing within the same column", () => {
    expect(moveThread(original, "1", "To Plan")).toBeNull();
  });

  it("removes the prefix when moved to Uncategorized", () => {
    expect(moveThread(original, "1", UNCATEGORIZED)?.newName).toBe("Build");
  });

  it("preserves a snapshot for rollback", () => {
    const result = moveThread(original, "1", "Review");
    expect(result?.previous).toEqual(original[0]);
    expect(result?.threads.map((item) => item.category)).toEqual(["Review"]);
  });
});
