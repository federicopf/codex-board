// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";
import { MarkdownContent } from "./MarkdownContent";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
afterEach(() => { cleanup(); vi.mocked(invoke).mockReset(); });

it("opens a localhost address in the desktop browser command", () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  render(<MarkdownContent>{"Preview: localhost:3000"}</MarkdownContent>);
  fireEvent.click(screen.getByRole("link", { name: "localhost:3000" }));
  expect(invoke).toHaveBeenCalledWith("open_external_url", { url: "http://localhost:3000" });
});

it("shows the Windows open error instead of silently swallowing it", async () => {
  vi.mocked(invoke).mockRejectedValue("No browser is configured");
  render(<MarkdownContent>{"[Preview](http://localhost:3000)"}</MarkdownContent>);
  fireEvent.click(screen.getByRole("link", { name: "Preview" }));
  await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("No browser is configured"));
});
