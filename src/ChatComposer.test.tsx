// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatDraftStore } from "@codex-board/protocol";
import { ChatComposer } from "./ChatPanel";

vi.mock("./lib/turnSettings", () => ({
  turnPreferences: { thread: () => ({ getSnapshot: () => ({ settings: { model: "fixture" } }) }) },
  useTurnPreferences: () => ({ settings: { model: "fixture" }, update: vi.fn(), error: null, saving: false }),
}));
vi.mock("./api", () => ({
  getModels: vi.fn(async () => ({ data: [] })), compactThread: vi.fn(),
  asCodexError: (error: Error) => ({ message: error.message }),
  interruptTurn: vi.fn(), loadThread: vi.fn(), respondToCodexRequest: vi.fn(),
}));
afterEach(cleanup);
const photo = { id: "a", name: "Saved photo", dataUrl: "data:image/jpeg;base64,AA==" };
async function fixture() {
  const store = new ChatDraftStore({ read: async () => null, write: vi.fn(async () => undefined) }, 60_000);
  await store.load("a"); await store.load("b");
  return store;
}
const mount = (drafts: ChatDraftStore, onSend: (threadId: string, text: string, imageUrls?: string[]) => Promise<void> = vi.fn(async () => undefined), threadId = "a") => render(
  <ChatComposer drafts={drafts} threadId={threadId} working={false} activeTurnId={null} loading={false} onSend={onSend} onStop={vi.fn()} onError={vi.fn()}/>
);
describe("desktop composer draft retention", () => {
  it("restores text and attachments after closing and reopening the chat", async () => {
    const drafts = await fixture();
    drafts.update("a", () => ({ text: "Unsent message", attachments: [photo] }));
    const view = mount(drafts);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent message");
    expect(screen.getByText("Saved photo")).toBeTruthy();
    view.unmount(); mount(drafts);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent message");
    expect(screen.getByText("Saved photo")).toBeTruthy();
  });
  it("never puts one conversation's draft into another", async () => {
    const drafts = await fixture();
    const view = mount(drafts);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "For thread A" } });
    view.unmount(); const other = mount(drafts, undefined, "b");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "For thread B" } });
    other.unmount(); mount(drafts);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "For thread A");
  });
  it("keeps text and photos when sending fails", async () => {
    const drafts = await fixture();
    drafts.update("a", () => ({ text: "Do not lose", attachments: [photo] }));
    const send = vi.fn(async () => { throw new Error("Offline"); });
    mount(drafts, send);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", false));
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Do not lose");
    expect(screen.getByText("Saved photo")).toBeTruthy();
  });
  it("does not erase newer typing when an earlier send succeeds, including after unmount", async () => {
    const drafts = await fixture();
    drafts.update("a", () => ({ text: "First", attachments: [photo] }));
    let resolve!: () => void;
    const send = vi.fn(() => new Promise<void>(done => { resolve = done; }));
    const view = mount(drafts, send);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Next message" } });
    view.unmount();
    await act(async () => { resolve(); });
    mount(drafts);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Next message");
    expect(screen.queryByText("Saved photo")).toBeNull();
    expect(send).toHaveBeenCalledExactlyOnceWith("a", "First", [photo.dataUrl]);
  });
});
