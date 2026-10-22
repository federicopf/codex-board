// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationResultDialog } from "./AutomationResultDialog";
afterEach(cleanup);

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
      automation: { id: "a-1", name: "Daily report", result: "Found **3 records** and updated the report.", noteworthy: ["The first retry recovered a timeout."], status: "completed", durationMs: 1500 },
    }} onClose={vi.fn()} onOpenThread={onOpenThread} />);
    expect(screen.getByRole("dialog", { name: "Daily report" })).toBeTruthy();
    expect(screen.getByText("3 records")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Summary" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Worth noting" })).toBeTruthy();
    expect(screen.getByText("The first retry recovered a timeout.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open full conversation" }));
    expect(onOpenThread).toHaveBeenCalledWith("t-1");
  });
  it.each(["failed", "interrupted", "unknown", "success"])("shows %s accurately and only offers relevant retries", status => {
    render(<AutomationResultDialog notification={{
      id: "n", kind: "automation", title: "Result", message: "Result", threadId: null, createdAt: 1, read: false,
      automation: { id: "a", name: "Review", result: "Short report", status, durationMs: null },
    }} onClose={vi.fn()} onOpenThread={vi.fn()}/>);
    const label = status === "success" ? "Success" : status === "unknown" ? "Unverified" : "Failed";
    expect(screen.getByText(label)).toBeTruthy();
    expect(Boolean(screen.queryByRole("button", { name: "Retry" }))).toBe(status !== "success");
    expect(screen.queryByText("Completed successfully")).toBeNull();
  });
});
