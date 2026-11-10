// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { runAutomationNow } from "./api";
import { RunAutomationButton } from "./RunAutomationButton";

vi.mock("./api", () => ({ runAutomationNow: vi.fn() }));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it("confirms and starts only the selected automation once", async () => {
  vi.mocked(runAutomationNow).mockResolvedValue();
  const accepted = vi.fn();
  render(<RunAutomationButton id="chosen" name="Daily check" onAccepted={accepted}/>);
  fireEvent.click(screen.getByRole("button", { name: "Run Daily check now" }));
  expect(runAutomationNow).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Confirm run" }));
  await waitFor(() => expect(runAutomationNow).toHaveBeenCalledExactlyOnceWith("chosen"));
  expect(accepted).toHaveBeenCalledOnce();
  expect(await screen.findByRole("button", { name: "Run Daily check now" })).toHaveProperty("disabled", false);
});

it("disables manual run while an automation is queued or running", () => {
  render(<RunAutomationButton id="chosen" name="Daily check" disabled/>);
  expect(screen.getByRole("button", { name: "Run Daily check now" })).toHaveProperty("disabled", true);
});
