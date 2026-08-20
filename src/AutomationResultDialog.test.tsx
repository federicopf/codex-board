// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AutomationResultDialog } from "./AutomationResultDialog";

describe("AutomationResultDialog", () => {
  it("shows the concise result and keeps the full conversation secondary", () => {
    const onOpenThread = vi.fn();
    render(<AutomationResultDialog notification={{
      id: "n-1",
      kind: "automation",
      title: "Automation completed",
      message: "Daily report finished",
      threadId: "t-1",
      createdAt: 1_700_000_000_000,
      read: false,
      automation: { id: "a-1", name: "Daily report", result: "Found **3 records** and updated the report.", status: "completed", durationMs: 1500 },
    }} onClose={vi.fn()} onOpenThread={onOpenThread} />);
    expect(screen.getByRole("dialog", { name: "Daily report" })).toBeTruthy();
    expect(screen.getByText("3 records")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open full conversation" }));
    expect(onOpenThread).toHaveBeenCalledWith("t-1");
  });
});
