// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { NewProjectDialog } from "./NewProjectDialog";

afterEach(cleanup);

it("creates a WSL project and asks to start a chat", async () => {
  const onCreate = vi.fn().mockResolvedValue(undefined);
  render(<NewProjectDialog existingPaths={[]} onClose={vi.fn()} onCreate={onCreate} />);
  fireEvent.change(screen.getByLabelText("Location"), { target: { value: "wsl" } });
  fireEvent.change(screen.getByLabelText("Folder under /var/www/"), { target: { value: "personal-projects/tkss-valencia" } });
  expect(screen.getByText("\\\\wsl$\\Debian\\var\\www\\personal-projects\\tkss-valencia")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Create and start chat" }));
  await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ kind: "wsl", distribution: "Debian", path: "personal-projects/tkss-valencia" }, true));
});
