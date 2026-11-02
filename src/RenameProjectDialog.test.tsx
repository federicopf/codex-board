// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RenameProjectDialog } from "./RenameProjectDialog";

describe("rename project dialog", () => {
  it("saves only a display name for the existing project path", async () => {
    const onRename = vi.fn(async () => undefined);
    const onClose = vi.fn();
    render(<RenameProjectDialog project={{ key: "c:/work/amati", cwd: "C:\\Work\\Amati", label: "Amati" }} onRename={onRename} onClose={onClose} />);
    expect(screen.getByText("C:\\Work\\Amati")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Name" }), { target: { value: "Amati Studio" } });
    fireEvent.click(screen.getByRole("button", { name: "Save name" }));
    await waitFor(() => expect(onRename).toHaveBeenCalledWith("Amati Studio"));
    expect(onClose).toHaveBeenCalled();
  });
});
