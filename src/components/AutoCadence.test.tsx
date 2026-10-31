// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutoCadence } from "./AutoCadence";

afterEach(cleanup);

function setup(language: "ja" | "en" = "en", onSave = vi.fn(async () => {})) {
  const props = {
    value: { intervalMinutes: 60, maxRunsPerDay: 2 },
    revisionKey: "initial",
    language,
    onSave,
  };
  const view = render(<AutoCadence {...props} />);
  fireEvent.click(screen.getByRole("button", { expanded: false }));
  return { ...view, props, onSave, input: screen.getByRole("spinbutton") };
}

describe("AutoCadence keyboard editing", () => {
  it.each([
    "ja",
    "en",
  ] as const)("connects invalid limits to localized errors and supports correction in %s", async (language) => {
    const { input, onSave } = setup(language);
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.keyDown(input, { key: "Enter" });
    const error = screen.getByRole("alert");
    expect(error.textContent).toBe(
      language === "ja"
        ? "上限は1回以上の整数で指定してください"
        : "Enter a whole number of at least 1 for the run limit.",
    );
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe(error.id);
    expect(document.activeElement).toBe(input);
    expect(onSave).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "3" } });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(input.hasAttribute("aria-invalid")).toBe(false);
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(onSave).toHaveBeenCalledExactlyOnceWith({ intervalMinutes: 60, maxRunsPerDay: 3 });
    expect(screen.queryByRole("spinbutton")).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole("button", { expanded: false }));
  });

  it("does not submit while composing or after settings have changed", () => {
    const { input, onSave, rerender, props } = setup();
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    expect(onSave).not.toHaveBeenCalled();
    rerender(<AutoCadence {...props} revisionKey="updated" />);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(
      "Settings changed. Close and reopen to review them.",
    );
  });

  it("prevents duplicate submissions and retains failed edits for retry", async () => {
    let reject!: (error: Error) => void;
    const onSave = vi.fn(
      () =>
        new Promise<void>((_resolve, no) => {
          reject = no;
        }),
    );
    const { input } = setup("en", onSave);
    fireEvent.change(input, { target: { value: "4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSave).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Save failed")));
    expect(screen.getByRole("alert").textContent).toBe("Save failed");
    expect((screen.getByRole("spinbutton") as HTMLInputElement).value).toBe("4");
    onSave.mockResolvedValueOnce();
    await act(async () => fireEvent.keyDown(input, { key: "Enter" }));
    expect(onSave).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("spinbutton")).toBeNull();
  });
});
