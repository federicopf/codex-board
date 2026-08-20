import { describe, expect, it } from "vitest";
import { applyCodexEvent, createChatSession, eventRequest, visibleUserMessage } from "./chat";

describe("chat session", () => {
  it("converts persisted turns into display items", () => {
    const session = createChatSession({ id: "thr_1", turns: [{ id: "turn_1", status: "completed", items: [
      { id: "user_1", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
      { id: "agent_1", type: "agentMessage", text: "Hi" },
      { id: "command_1", type: "commandExecution", command: "git status", status: "completed" },
    ] }] });
    expect(session.items.map(({ kind, text }) => ({ kind, text }))).toEqual([
      { kind: "user", text: "Hello" },
      { kind: "assistant", text: "Hi" },
      { kind: "activity", text: "git status" },
    ]);
    expect(session.running).toBe(false);
  });

  it("streams an agent response and completes the turn", () => {
    const empty = createChatSession({ id: "thr_1", turns: [] });
    const started = applyCodexEvent(empty, { method: "turn/started", params: { threadId: "thr_1", turn: { id: "turn_2" } } }, "thr_1");
    const first = applyCodexEvent(started, { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_2", itemId: "agent_2", delta: "Hello " } }, "thr_1");
    const second = applyCodexEvent(first, { method: "item/agentMessage/delta", params: { threadId: "thr_1", turnId: "turn_2", itemId: "agent_2", delta: "again" } }, "thr_1");
    const completed = applyCodexEvent(second, { method: "turn/completed", params: { threadId: "thr_1", turn: { id: "turn_2", status: "completed" } } }, "thr_1");
    expect(completed.items[0].text).toBe("Hello again");
    expect(completed.running).toBe(false);
    expect(completed.activeTurnId).toBeNull();
  });

  it("scopes approval requests to the open thread", () => {
    const request = eventRequest({ method: "item/commandExecution/requestApproval", requestId: 42, params: { threadId: "thr_1", command: "npm test" } }, "thr_1");
    expect(request?.requestId).toBe(42);
    expect(eventRequest({ method: "item/commandExecution/requestApproval", requestId: 42, params: { threadId: "thr_other" } }, "thr_1")).toBeNull();
  });

  it("hides the implicit automation result instruction", () => {
    expect(visibleUserMessage("Run the report\n\n<!-- codex-board-automation: internal summary instruction -->"))
      .toBe("Run the report");
  });
});
