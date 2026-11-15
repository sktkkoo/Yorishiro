// @vitest-environment jsdom

import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, createEvent, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ResultText } from "./ResultText";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
beforeEach(() => vi.mocked(openUrl).mockReset().mockResolvedValue(undefined));
afterEach(cleanup);

it("preserves literal text and line breaks without interpreting HTML or opening anything", () => {
  const text =
    "Result: https://example.com/pull/1.\n<img src=x onerror=alert(1)>\nhttps://user:secret@example.com";
  const view = render(
    <p>
      <ResultText text={text} language="en" />
    </p>,
  );
  expect(view.container.textContent).toBe(text);
  expect(view.container.querySelector("img")).toBeNull();
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(openUrl).not.toHaveBeenCalled();
});

it.each([
  "primary",
  "keyboard",
  "middle",
] as const)("opens only externally on %s activation and prevents default navigation", async (activation) => {
  render(<ResultText text="https://example.com/result" language="en" />);
  const link = screen.getByRole("link", { name: "https://example.com/result" });
  link.focus();
  expect(document.activeElement).toBe(link);
  // ネイティブのリンクは Enter を detail=0 の click として通知する。
  const event =
    activation === "middle"
      ? new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true })
      : createEvent.click(link, { button: 0, detail: activation === "keyboard" ? 0 : 1 });
  await act(async () => fireEvent(link, event));
  expect(event.defaultPrevented).toBe(true);
  expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://example.com/result");
  expect(document.activeElement).toBe(link);
});

it.each([
  ["ja", "リンクを開けませんでした。もう一度選ぶか、URLをコピーしてください。"],
  ["en", "Could not open the link. Try it again or copy the URL."],
] as const)("keeps %s opening failures local to their link and allows retry", async (language, message) => {
  vi.mocked(openUrl).mockRejectedValueOnce(new Error("private operating-system detail"));
  const text = "https://example.com/one。\nNext: https://example.com/two.";
  const view = render(<ResultText text={text} language={language} />);
  const one = screen.getByRole("link", { name: "https://example.com/one" });
  const two = screen.getByRole("link", { name: "https://example.com/two" });
  await act(async () => fireEvent.click(one));
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toBe(message);
  expect(view.container.textContent).toBe(text + message);
  expect(one.getAttribute("aria-describedby")).toBe(alert.id);
  expect(two.hasAttribute("aria-describedby")).toBe(false);
  expect(one.getAttribute("href")).toBe("https://example.com/one");
  expect(screen.queryByText("private operating-system detail")).toBeNull();
  await act(async () => fireEvent.click(one));
  expect(openUrl).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("ignores right activation and deduplicates an opening already in progress", async () => {
  let finish!: () => void;
  vi.mocked(openUrl).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  render(<ResultText text="https://example.com/result" language="en" />);
  const link = screen.getByRole("link");
  fireEvent(link, new MouseEvent("auxclick", { button: 2, bubbles: true, cancelable: true }));
  expect(openUrl).not.toHaveBeenCalled();
  fireEvent.click(link);
  fireEvent(link, new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
  expect(openUrl).toHaveBeenCalledTimes(1);
  await act(async () => finish());
});
