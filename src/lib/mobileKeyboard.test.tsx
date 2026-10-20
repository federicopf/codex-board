// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatKeyboardFrame } from "../../apps/mobile/src/ChatKeyboardFrame";

const environment = vi.hoisted(() => ({ os: "android", top: 64 }));
vi.mock("react-native", async () => {
  const { forwardRef, useImperativeHandle } = await import("react");
  return {
    Platform: { get OS() { return environment.os; } }, StyleSheet: { create: (styles: unknown) => styles },
    View: forwardRef((props: { children?: import("react").ReactNode; onLayout: () => void }, ref) => {
      useImperativeHandle(ref, () => ({ measureInWindow: (callback: (x: number, y: number) => void) => callback(0, environment.top) }));
      return <div data-testid="viewport" onClick={props.onLayout}>{props.children}</div>;
    }),
    KeyboardAvoidingView: (props: { children?: import("react").ReactNode; behavior: string; keyboardVerticalOffset: number }) =>
      <div data-testid="keyboard-frame" data-behavior={props.behavior} data-offset={props.keyboardVerticalOffset}>{props.children}</div>,
  };
});
afterEach(cleanup);
describe("chat keyboard layout", () => {
  it.each([["android", "height"], ["ios", "padding"]])("enables keyboard avoidance on %s with the actual viewport offset", (os, behavior) => {
    environment.os = os;
    render(<ChatKeyboardFrame><div>Composer</div></ChatKeyboardFrame>);
    fireEvent.click(screen.getByTestId("viewport"));
    expect(screen.getByTestId("keyboard-frame").getAttribute("data-behavior")).toBe(behavior);
    expect(screen.getByTestId("keyboard-frame").getAttribute("data-offset")).toBe("64");
  });
});
