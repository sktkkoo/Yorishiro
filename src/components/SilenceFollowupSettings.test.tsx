// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { setRealtimeDebugEnabled } from "../runtime/codex-realtime/realtime-debug";
import { readSilenceFollowupSettings } from "../runtime/codex-realtime/silence-followup-settings";
import { SilenceFollowupSettings } from "./SilenceFollowupSettings";

afterEach(() => {
  cleanup();
  localStorage.clear();
});
it("hides experimental controls for ordinary users and requires a second explicit opt-in", () => {
  const { container } = render(<SilenceFollowupSettings language="en" />);
  expect(container.textContent).toBe("");
  act(() => setRealtimeDebugEnabled(true));
  const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
  expect(checkbox.checked).toBe(false);
  expect(screen.getByText(/Requires Codex 0.169.0/)).toBeTruthy();
  expect(screen.getByText(/Provider usage may be billed/)).toBeTruthy();
  fireEvent.click(checkbox);
  expect(readSilenceFollowupSettings().enabled).toBe(true);
  act(() => setRealtimeDebugEnabled(false));
  expect(container.textContent).toBe("");
  expect(readSilenceFollowupSettings().enabled).toBe(false);
});
