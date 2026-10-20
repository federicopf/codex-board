// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RetryAutomationButton } from "./RetryAutomationButton";
import { retryAutomation } from "./api";

vi.mock("./api", () => ({ retryAutomation: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);
describe("manual automation retry", () => {
  it("requires confirmation and submits only once while the request is pending", async () => {
    let resolve!: () => void;
    vi.mocked(retryAutomation).mockImplementation(() => new Promise<void>(done => { resolve = done; }));
    const accepted = vi.fn();
    render(<RetryAutomationButton id="a" onAccepted={accepted}/>);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retryAutomation).not.toHaveBeenCalled();
    expect(screen.getByText(/partially completed/)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: "Confirm retry" });
    fireEvent.click(confirm); fireEvent.click(confirm);
    expect(retryAutomation).toHaveBeenCalledExactlyOnceWith("a");
    resolve();
    await waitFor(() => expect(accepted).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Retry requested" })).toHaveProperty("disabled", true);
  });
  it("keeps confirmation available after a failed request", async () => {
    vi.mocked(retryAutomation).mockRejectedValue(new Error("Already queued"));
    render(<RetryAutomationButton id="a"/>);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm retry" }));
    await screen.findByText("Already queued");
    expect(screen.getByRole("button", { name: "Confirm retry" })).toHaveProperty("disabled", false);
  });
  it("cannot retry a workflow marked in flight", () => {
    render(<RetryAutomationButton id="a" disabled/>);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.queryByRole("button", { name: "Confirm retry" })).toBeNull();
    expect(retryAutomation).not.toHaveBeenCalled();
  });
});
