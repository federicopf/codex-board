import { describe, expect, it } from "vitest";
import { reconcilePendingChatMessages } from "../../apps/mobile/src/chatPendingMessages";

describe("mobile pending chat messages", () => {
  it("keeps a sent message visible until it appears in the server history", () => {
    const pending = [{ id: "local", text: "Ciao", imageCount: 0, afterIndex: 12, accepted: true }];
    expect(reconcilePendingChatMessages(pending, { messages: [{ index: 11, item: { type: "userMessage", content: [{ type: "text", text: "Ciao" }] } }] })).toEqual(pending);
    expect(reconcilePendingChatMessages(pending, { messages: [{ index: 12, item: { type: "userMessage", content: [{ type: "text", text: "Ciao" }] } }] })).toEqual([]);
  });

  it("matches repeated messages one at a time", () => {
    const pending = [
      { id: "first", text: "Ancora", imageCount: 0, afterIndex: 3, accepted: true },
      { id: "second", text: "Ancora", imageCount: 0, afterIndex: 3, accepted: true },
    ];
    const thread = { messages: [{ index: 3, item: { type: "userMessage", content: [{ type: "text", text: "Ancora" }] } }] };
    expect(reconcilePendingChatMessages(pending, thread)).toEqual([pending[1]]);
  });

  it("does not hide a message before the send request is accepted", () => {
    const pending = [{ id: "sending", text: "Ciao", imageCount: 0, afterIndex: 0, accepted: false }];
    const thread = { messages: [{ index: 0, item: { type: "userMessage", content: [{ type: "text", text: "Ciao" }] } }] };
    expect(reconcilePendingChatMessages(pending, thread)).toEqual(pending);
  });
});
