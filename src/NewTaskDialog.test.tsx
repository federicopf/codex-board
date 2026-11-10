// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { NewTaskDialog } from "./NewTaskDialog";
import { getModels } from "./api";

vi.mock("./api", () => ({ getModels: vi.fn(), asCodexError: (error: unknown) => ({ message: String(error) }) }));
beforeEach(() => vi.mocked(getModels).mockResolvedValue({ data: [{ model: "model-a", displayName: "Model A" }, { model: "model-b", displayName: "Model B" }] }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("passes the model chosen for the new conversation to the first-turn create operation", async () => {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(<NewTaskDialog threads={[]} projects={[{ key: "/test", cwd: "/test", label: "Test" }]} categories={["Review"]} defaultModel="model-a" onClose={vi.fn()} onCreate={onCreate} />);
  await screen.findByRole("option", { name: "Model B" });
  fireEvent.change(screen.getByLabelText("Model for this chat"), { target: { value: "model-b" } });
  fireEvent.change(screen.getByLabelText("Task title"), { target: { value: "New task" } });
  fireEvent.change(screen.getByLabelText("First message"), { target: { value: "Start work" } });
  fireEvent.click(screen.getByRole("button", { name: "Create and start" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith("/test", "Review", "New task", "Start work", [], "model-b"));
});
