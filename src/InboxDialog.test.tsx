// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { InboxDialog } from "./InboxDialog";

describe("InboxDialog", () => {
  it("keeps automation results in their own tab", () => {
    render(<InboxDialog
      items={[
        { id: "regular", kind: "done", title: "Task completed", message: "Ready", threadId: "t-1", createdAt: 1, read: false },
        { id: "automation", kind: "automation", title: "Automation completed", message: "Done", threadId: "t-2", createdAt: 2, read: false, automation: { id: "a-1", name: "Daily review", result: "Ready", status: "completed", durationMs: 10 } },
      ]}
      threads={[{ id: "t-2", name: "Review - Content", preview: null, cwd: "/amati", updatedAt: 2, category: "Review", displayTitle: "Content", effectiveTitle: "Review - Content", projectKey: "/amati", projectLabel: "Amati" }]}
      customers={[{ id: "client", name: "Amati Content", projectCwd: "/amati", threadIds: ["t-2"] }]}
      onOpen={vi.fn()} onOpenResult={vi.fn()} onReadAll={vi.fn()} onClear={vi.fn()} onClose={vi.fn()}
    />);

    expect(screen.getByText("Task completed")).toBeTruthy();
    expect(screen.queryByText("Daily review")).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Automations/ }));
    expect(screen.getByText("Amati", { selector: ".inbox-project-group h3" })).toBeTruthy();
    expect(screen.getByText("Daily review")).toBeTruthy();
    expect(screen.getByText("Amati Content · Content")).toBeTruthy();
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.queryByText("Task completed")).toBeNull();
  });
});
