import { describe, expect, it } from "vitest";
import { enqueueMessage, removeQueuedMessage, takeNextMessage } from "./messageQueue";

describe("message queue", () => {
  it("keeps messages in FIFO order per thread", () => {
    let queues = {};
    queues = enqueueMessage(queues, "thread-1", { id: "one", text: "First" });
    queues = enqueueMessage(queues, "thread-1", { id: "two", text: "Second" });
    const first = takeNextMessage(queues, "thread-1");
    const second = takeNextMessage(first.queues, "thread-1");
    expect(first.message?.text).toBe("First");
    expect(second.message?.text).toBe("Second");
    expect(second.queues).toEqual({});
  });

  it("keeps queues isolated and allows removing a pending message", () => {
    const queues = {
      alpha: [{ id: "a", text: "Alpha" }],
      beta: [{ id: "b", text: "Beta" }],
    };
    expect(removeQueuedMessage(queues, "alpha", "a")).toEqual({ beta: queues.beta });
  });
});
