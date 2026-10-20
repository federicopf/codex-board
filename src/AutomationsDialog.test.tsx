// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AutomationsDialog } from "./AutomationsDialog";
import { createAutomation, deleteAutomation, listAutomations, updateAutomation } from "./api";
import type { Automation } from "@codex-board/protocol";
import type { BoardThread } from "./types";

vi.mock("./api", () => ({
  listAutomations: vi.fn(), createAutomation: vi.fn(), updateAutomation: vi.fn(),
  deleteAutomation: vi.fn(), setAutomationEnabled: vi.fn(), retryAutomation: vi.fn(),
}));
const recurring: Automation = {
  id: "stable", name: "Daily check", enabled: false, lastRunAt: 10, lastError: null,
  action: { kind: "recurringMessage", threadId: "t", prompt: "Original prompt", everyMinutes: 120, nextRunAt: 42 },
};
const threads: BoardThread[] = [{ id: "t", name: "Review - Test", preview: null, cwd: "/test", updatedAt: 1, category: "Review", displayTitle: "Test", effectiveTitle: "Review - Test", projectKey: "/test", projectLabel: "Test project" }];
const mount = () => render(<AutomationsDialog threads={threads} categories={["Review", "Ship"]} onClose={vi.fn()} />);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(listAutomations).mockResolvedValue([recurring]);
  vi.mocked(updateAutomation).mockResolvedValue(recurring);
});
afterEach(cleanup);

describe("workflow editing", () => {
  it("uses an accessible trash icon without a visible Delete label", async () => {
    vi.mocked(deleteAutomation).mockResolvedValue(true);
    mount();
    const button = await screen.findByRole("button", { name: "Delete Daily check" });
    expect(button.textContent).toBe("");
    expect(button.querySelector("svg")).not.toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(deleteAutomation).toHaveBeenCalledExactlyOnceWith("stable"));
  });
  it("shows last-run outcome separately from schedule state and blocks duplicate retries", async () => {
    vi.mocked(listAutomations).mockResolvedValue([{ ...recurring, enabled: true, runState: "running",
      lastResult: { status: "failed", summary: "Access expired", finishedAt: 1 } }]);
    mount();
    await screen.findByText("Access expired");
    expect(screen.getByText("Active", { selector: ".automation-status" })).toBeTruthy();
    expect(screen.getByText("Failed")).toBeTruthy();
    expect(screen.getByText("Running")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty("disabled", true);
  });
  it("prefills and updates the existing automation without recreating it", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Daily check" }));
    expect((screen.getByLabelText("Name") as HTMLInputElement).value).toBe("Daily check");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Original prompt");
    expect(screen.getByRole("spinbutton")).toHaveProperty("value", "2");
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Short new prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenCalledWith("stable", {
      name: "Daily check", action: { kind: "recurringMessage", threadId: "t", prompt: "Short new prompt", everyMinutes: 120, startInMinutes: 120 },
    }));
    expect(createAutomation).not.toHaveBeenCalled();
    await screen.findByText("Automations & pipelines");
  });

  it("edits pipelines and retains categories absent from the current board", async () => {
    vi.mocked(listAutomations).mockResolvedValue([{ ...recurring, name: "Pipeline", action: { kind: "categoryPipeline", fromCategory: "Custom", toCategory: "Archive", afterMinutes: 75 } }]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Pipeline" }));
    expect(screen.getByLabelText("From")).toHaveProperty("value", "Custom");
    expect(screen.getByLabelText("To")).toHaveProperty("value", "Archive");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed pipeline" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenCalledWith("stable", {
      name: "Renamed pipeline", action: { kind: "categoryPipeline", fromCategory: "Custom", toCategory: "Archive", afterMinutes: 75 },
    }));
  });

  it("retains the edited form after a save fails", async () => {
    vi.mocked(updateAutomation).mockRejectedValueOnce(new Error("Disk unavailable"));
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Daily check" }));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Unsaved name" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Disk unavailable");
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Unsaved name");
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
  });

  it("does not reuse an edit identity when opening creation after cancel", async () => {
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Daily check" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "+ Automation" }));
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "");
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();
    expect(updateAutomation).not.toHaveBeenCalled();
  });

  it("allows metadata edits for completed one-off schedules", async () => {
    vi.mocked(listAutomations).mockResolvedValue([{ ...recurring, action: { kind: "scheduledMessage", threadId: "t", prompt: "Original prompt", runAt: 1700000004321 } }]);
    mount();
    fireEvent.click(await screen.findByRole("button", { name: "Edit Daily check" }));
    expect(screen.getByRole("button", { name: "Save changes" })).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(updateAutomation).toHaveBeenCalledWith("stable", expect.objectContaining({ action: expect.objectContaining({ runAt: 1700000004321 }) })));
  });
});
