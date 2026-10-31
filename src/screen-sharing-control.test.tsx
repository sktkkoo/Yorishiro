// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ScreenSharingControl, type ScreenSharingControlProps } from "./screen-sharing-control";

let panelHeight = 380;
let measuredPanels: HTMLElement[] = [];
beforeEach(() => {
  panelHeight = 380;
  measuredPanels = [];
  vi.stubGlobal("innerWidth", 1024);
  vi.stubGlobal("innerHeight", 768);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.classList.contains("screen-sharing-panel")) {
      measuredPanels.push(this);
      return new DOMRect(120, 40, Number.parseFloat(this.style.width), panelHeight);
    }
    return new DOMRect(120, 8, 24, 24);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function props(): ScreenSharingControlProps {
  return {
    activeViewModeId: null,
    available: true,
    active: false,
    busy: false,
    pointersEnabled: true,
    pointersReady: true,
    intervalSeconds: 30,
    sources: [{ id: 1, name: "Display 1" }],
    sourceId: 1,
    onIntervalChange: vi.fn(),
    onSourceChange: vi.fn(),
    onStart: vi.fn(),
    onStop: vi.fn(),
    onPointersEnabledChange: vi.fn(),
    onRetryPointers: vi.fn(),
    onRefreshSources: vi.fn(),
    onOpenAuxiliary: vi.fn().mockResolvedValue(undefined),
    language: "ja",
  };
}
describe("screen sharing control", () => {
  it.each([
    ["ja", "画面共有", "更新間隔", "画面について尋ねると、最新の画像を確認します。", "送信間隔"],
    [
      "en",
      "Screen sharing",
      "Refresh interval",
      "Ask about the screen to share the latest image.",
      "Send interval",
    ],
  ])("explains on-demand delivery without per-capture token claims in %s", (language, title, interval, hint, contextInterval) => {
    const p = { ...props(), language };
    const view = render(<ScreenSharingControl {...p} deliveryMode="on-demand" />);
    fireEvent.click(screen.getByRole("button", { name: title }));
    expect(screen.getByRole("slider", { name: interval })).toBeTruthy();
    expect(screen.getByText(hint)).toBeTruthy();
    expect(view.container.textContent).not.toMatch(/tokens|トークン/);
    view.rerender(<ScreenSharingControl {...p} />);
    expect(screen.getByRole("slider", { name: contextInterval })).toBeTruthy();
    expect(view.container.textContent).toMatch(/tokens|トークン/);
  });

  it.each([
    "screen",
    "camera",
  ] as const)("shows frame count only when motion is enabled for %s", (sourceKind) => {
    const p = {
      ...props(),
      sourceKind,
      contactSheetFrameCount: 9,
      onContactSheetFrameCountChange: vi.fn(),
    };
    const view = render(<ScreenSharingControl {...p} />);
    fireEvent.click(
      screen.getByRole("button", { name: sourceKind === "camera" ? "カメラ共有" : "画面共有" }),
    );
    expect(screen.getByRole("slider", { name: "まとめるコマ数" })).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "コマ送りで動きを伝える" }));
    expect(p.onContactSheetFrameCountChange).toHaveBeenLastCalledWith(1);
    view.rerender(<ScreenSharingControl {...p} contactSheetFrameCount={1} />);
    expect(screen.queryByRole("slider", { name: "まとめるコマ数" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "コマ送りで動きを伝える" }));
    expect(p.onContactSheetFrameCountChange).toHaveBeenLastCalledWith(9);
  });

  it("starts region selection from Start without a separate picker action", () => {
    const p = {
      ...props(),
      language: "en",
      screenSourceKind: "region" as const,
      pointersReady: false,
      sources: [],
      sourceId: null,
      onScreenSourceKindChange: vi.fn(),
    };
    const view = render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Screen sharing" }));
    expect(screen.getByRole("tablist", { name: "Screen source type" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Start sharing" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.queryByRole("button", { name: "Select region" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Agent pointing (experimental)" })).toBeNull();
    view.rerender(
      <ScreenSharingControl
        {...p}
        region={{ x: 10, y: 10, width: 300, height: 200, displayWidth: 1920, displayHeight: 1080 }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    expect(p.onStart).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: "Window" }));
    expect(p.onScreenSourceKindChange).toHaveBeenCalledWith("window");
  });

  it("navigates source tabs with arrow keys and Home/End", () => {
    const p = { ...props(), language: "en", onScreenSourceKindChange: vi.fn() };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Screen sharing" }));
    const display = screen.getByRole("tab", { name: "Display" });
    expect(display.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(display, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Window" }));
    expect(display.tabIndex).toBe(-1);
    expect(display.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Window" }).tabIndex).toBe(0);
    expect(screen.getByRole("tab", { name: "Window" }).getAttribute("aria-selected")).toBe("false");
    expect(p.onScreenSourceKindChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Window" }), { key: "End" });
    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "Area" }));
    expect(p.onScreenSourceKindChange).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole("tab", { name: "Area" }), { key: "Home" });
    expect(document.activeElement).toBe(display);
    expect(p.onScreenSourceKindChange).not.toHaveBeenCalled();
    expect(screen.getByRole("tabpanel", { name: "Display" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Window" }));
    expect(p.onScreenSourceKindChange).toHaveBeenCalledExactlyOnceWith("window");
  });

  it("locks source modes while the active region is adjusted on the desktop", () => {
    const p = {
      ...props(),
      language: "en",
      active: true,
      screenSourceKind: "region" as const,
      onScreenSourceKindChange: vi.fn(),
    };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Screen sharing on" }));
    expect(screen.queryByRole("button", { name: "Select region" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reselect region" })).toBeNull();
    for (const tab of screen.getAllByRole("tab"))
      expect((tab as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Close sharing settings" }).getAttribute("title"),
    ).toBe("Close sharing settings");
  });

  it("disables restricted source tabs on the old native backend while full display can start", () => {
    const p = {
      ...props(),
      language: "en",
      screenSelectionSupported: false,
      onScreenSourceKindChange: vi.fn(),
    };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Screen sharing" }));
    expect((screen.getByRole("tab", { name: "Window" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("tab", { name: "Area" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole("tab", { name: "Window" }).getAttribute("title")).toBe(
      "Not available in the running app yet",
    );
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    expect(p.onStart).toHaveBeenCalledOnce();
  });

  it("returns keyboard focus to the source chooser after Back", async () => {
    const p = { ...props(), language: "en", onSourceKindChange: vi.fn() };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Sharing" }));
    fireEvent.click(screen.getByRole("button", { name: "Share screen" }));
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    fireEvent.click(back);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Share screen" })),
    );
  });

  it("allows window sharing without pointer setup", () => {
    const p = {
      ...props(),
      language: "en",
      screenSourceKind: "window" as const,
      pointersReady: false,
      onScreenSourceKindChange: vi.fn(),
    };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "Screen sharing" }));
    expect(screen.getByRole("combobox", { name: "Window" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    expect(p.onStart).toHaveBeenCalledOnce();
    expect(screen.queryByRole("switch", { name: "Agent pointing (experimental)" })).toBeNull();
  });

  it("shows camera preview by default and allows hiding it while capture continues", () => {
    const p = {
      ...props(),
      sourceKind: "camera" as const,
      active: true,
      busy: true,
      onPreviewVisibleChange: vi.fn(),
    };
    const view = render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "カメラ共有中" }));
    const toggle = screen.getByRole("switch", { name: "プレビュー" }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    expect(p.onPreviewVisibleChange).toHaveBeenCalledExactlyOnceWith(false);
    view.rerender(<ScreenSharingControl {...p} previewVisible={false} />);
    expect(toggle.checked).toBe(false);
    expect(p.onStop).not.toHaveBeenCalled();
    expect(p.onStart).not.toHaveBeenCalled();
    expect(p.onPointersEnabledChange).not.toHaveBeenCalled();
  });
  it("offers screen and camera under one button without starting capture", () => {
    const p = { ...props(), sourceKind: "screen" as const, onSourceKindChange: vi.fn() };
    const { rerender } = render(<ScreenSharingControl {...p} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "共有" }));
    expect(screen.getByRole("button", { name: "画面を共有" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "カメラを共有" }));
    const back = screen.getByRole("button", { name: "戻る" });
    expect(back.textContent).toBe("");
    expect(back.querySelector("svg.lucide-undo-2")).not.toBeNull();
    expect(back.getAttribute("title")).toBe("戻る");
    expect(back.nextElementSibling?.tagName).toBe("H2");
    expect(back.parentElement?.classList.contains("screen-sharing-heading")).toBe(true);
    expect(p.onSourceKindChange).toHaveBeenCalledWith("camera");
    expect(p.onStart).not.toHaveBeenCalled();
    rerender(
      <ScreenSharingControl
        {...p}
        sourceKind="camera"
        pointersReady={false}
        sources={[{ id: 2, name: "USB camera" }]}
        sourceId={2}
      />,
    );
    expect(screen.getByLabelText("カメラ選択")).toBeTruthy();
    expect(screen.queryByRole("switch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "共有を開始" }));
    expect(p.onStart).toHaveBeenCalledOnce();
  });

  it("offers retry after initial marker synchronization fails and prevents early sharing", () => {
    const p = { ...props(), pointersReady: false, error: "Could not update marker setting" };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect((screen.getByRole("button", { name: "共有を開始" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "指し示し設定を再試行" }));
    expect(p.onRetryPointers).toHaveBeenCalledOnce();
  });

  it("shows token guidance and supports the extended interval range", () => {
    const p = props();
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect(screen.getByText("間隔が短いほどトークン消費が増えます。")).toBeTruthy();
    expect(p.onStart).not.toHaveBeenCalled();
    const interval = screen.getByRole("slider") as HTMLInputElement;
    expect(interval.min).toBe("10");
    expect(interval.max).toBe("180");
    expect(interval.value).toBe("30");
    fireEvent.change(interval, { target: { value: "20" } });
    expect(p.onIntervalChange).toHaveBeenCalledWith(20);
    fireEvent.click(screen.getByRole("button", { name: "共有を開始" }));
    expect(p.onStart).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("does not turn repeated region Start clicks into cancellation", () => {
    const p = { ...props(), busy: true, screenSourceKind: "region" as const };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    const selecting = screen.getByRole("button", { name: "範囲を選択中…" });
    expect((selecting as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(selecting);
    fireEvent.click(selecting);
    expect(p.onStop).not.toHaveBeenCalled();
    expect(p.onStart).not.toHaveBeenCalled();
  });

  it("allows cancelling pending permission in a fitting inline panel", () => {
    const p = { ...props(), busy: true };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    const panel = screen.getByRole("dialog");
    expect(panel.style.left).toBe("120px");
    expect(panel.style.width).toBe("310px");
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(p.onStop).toHaveBeenCalledTimes(1);
  });

  it.each([
    "portrait",
    "companion",
  ])("always opens %s controls separately, even when the viewport is large", async (activeViewModeId) => {
    const p = { ...props(), activeViewModeId };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect(p.onOpenAuxiliary).toHaveBeenCalledOnce();
    expect(p.onRefreshSources).toHaveBeenCalledOnce();
    expect(measuredPanels).toHaveLength(0);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("slider")).toBeNull();
    expect(p.onStart).not.toHaveBeenCalled();
    expect(p.onStop).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "画面共有" }).getAttribute("aria-busy")).toBe(
        "false",
      ),
    );
  });

  it.each([
    null,
    "theater",
    "immersive",
    "custom-view",
  ])("keeps fitting %s controls inline without a manual popout button", (activeViewModeId) => {
    const p = { ...props(), activeViewModeId };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(p.onOpenAuxiliary).not.toHaveBeenCalled();
    expect(p.onRefreshSources).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "画面共有を別ウィンドウで開く" })).toBeNull();
  });

  it("measures an inert, unfocused panel once before deciding where to open", () => {
    const p = props();
    const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    measure.mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains("screen-sharing-panel")) return new DOMRect(120, 8, 24, 24);
      measuredPanels.push(this);
      expect(this.getAttribute("aria-hidden")).toBe("true");
      expect(this.hasAttribute("inert")).toBe(true);
      expect(this.style.visibility).toBe("hidden");
      expect(this.style.pointerEvents).toBe("none");
      expect(this.style.maxHeight).toBe("");
      expect(this.getAttribute("role")).toBe("dialog");
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "画面共有" }));
      expect(p.onOpenAuxiliary).not.toHaveBeenCalled();
      expect(p.onStart).not.toHaveBeenCalled();
      return new DOMRect(120, 40, 310, 380);
    });
    render(
      <StrictMode>
        <ScreenSharingControl {...p} />
      </StrictMode>,
    );
    const trigger = screen.getByRole("button", { name: "画面共有" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(measuredPanels).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "共有の設定を閉じる" }));
    expect(p.onRefreshSources).toHaveBeenCalledOnce();
    expect(p.onStart).not.toHaveBeenCalled();
    expect(p.onOpenAuxiliary).not.toHaveBeenCalled();
  });

  it.each([
    { width: 240, height: 768, naturalHeight: 380 },
    { width: 1024, height: 420, naturalHeight: 380 },
    { width: 1024, height: 600, naturalHeight: 560 },
  ])("opens separate controls when the measured form cannot fit $width x $height", async ({
    width,
    height,
    naturalHeight,
  }) => {
    vi.stubGlobal("innerWidth", width);
    vi.stubGlobal("innerHeight", height);
    panelHeight = naturalHeight;
    const p = { ...props(), activeViewModeId: "custom-view" };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect(measuredPanels).toHaveLength(1);
    expect(p.onOpenAuxiliary).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.onStart).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "画面共有" }).getAttribute("aria-busy")).toBe(
        "false",
      ),
    );
  });

  it("chooses again only on the next opening, without moving controls on resize or mode changes", async () => {
    const p = props();
    const view = render(<ScreenSharingControl {...p} />);
    const trigger = screen.getByRole("button", { name: "画面共有" });
    fireEvent.click(trigger);
    vi.stubGlobal("innerWidth", 240);
    vi.stubGlobal("innerHeight", 300);
    fireEvent(window, new Event("resize"));
    view.rerender(<ScreenSharingControl {...p} activeViewModeId="portrait" />);
    expect(p.onOpenAuxiliary).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog").style.width).toBe("216px");
    expect(measuredPanels).toHaveLength(1);
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    expect(p.onOpenAuxiliary).toHaveBeenCalledOnce();
    await waitFor(() => expect(trigger.getAttribute("aria-busy")).toBe("false"));
  });

  it("opens active sharing controls separately without refreshing, clearing, or stopping sharing", async () => {
    const p = {
      ...props(),
      activeViewModeId: "portrait",
      active: true,
      busy: true,
    };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有中" }));
    expect(p.onOpenAuxiliary).toHaveBeenCalledTimes(1);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "画面共有中" }).getAttribute("aria-busy")).toBe(
        "false",
      ),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.onRefreshSources).not.toHaveBeenCalled();
    expect(p.onStop).not.toHaveBeenCalled();
  });

  it("keeps one separate-window request pending across repeated clicks and keyboard openings", async () => {
    let finish!: () => void;
    const onOpenAuxiliary = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const p = { ...props(), activeViewModeId: "portrait", onOpenAuxiliary };
    render(<ScreenSharingControl {...p} />);
    const trigger = screen.getByRole("button", { name: "画面共有" });
    fireEvent.click(trigger);
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(onOpenAuxiliary).toHaveBeenCalledOnce();
    expect(trigger.getAttribute("aria-busy")).toBe("true");
    expect(p.onRefreshSources).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(p.onStart).not.toHaveBeenCalled();
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows only a compact error, retry, and close when a separate window fails", async () => {
    vi.stubGlobal("innerWidth", 200);
    vi.stubGlobal("innerHeight", 300);
    const p = {
      ...props(),
      activeViewModeId: "portrait",
      onOpenAuxiliary: vi
        .fn()
        .mockRejectedValueOnce(new Error("Unable to open controls"))
        .mockResolvedValueOnce(undefined),
    };
    render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Unable to open controls");
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByRole("dialog").style.width).toBe("176px");
    expect(screen.getByRole("dialog").style.top).toBe("40px");
    expect(screen.getByRole("dialog").style.maxHeight).toBe("248px");
    expect(screen.queryByRole("slider")).toBeNull();
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("switch")).toBeNull();
    expect(screen.queryByRole("button", { name: "共有を開始" })).toBeNull();
    const retry = screen.getByRole("button", {
      name: "画面共有ウィンドウを再試行",
    }) as HTMLButtonElement;
    expect(retry.disabled).toBe(false);
    fireEvent.click(retry);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(p.onOpenAuxiliary).toHaveBeenCalledTimes(2);
    expect(p.onStart).not.toHaveBeenCalled();
    expect(p.onStop).not.toHaveBeenCalled();
  });

  it("keeps a dismissed failure closed when an outstanding retry fails", async () => {
    let rejectRetry!: (error: Error) => void;
    const p = {
      ...props(),
      activeViewModeId: "companion",
      onOpenAuxiliary: vi
        .fn()
        .mockRejectedValueOnce(new Error("Unable to open controls"))
        .mockImplementationOnce(
          () =>
            new Promise<void>((_resolve, reject) => {
              rejectRetry = reject;
            }),
        ),
    };
    render(<ScreenSharingControl {...p} />);
    const trigger = screen.getByRole("button", { name: "画面共有" });
    fireEvent.click(trigger);
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "画面共有ウィンドウを再試行" }));
    fireEvent.click(screen.getByRole("button", { name: "共有の設定を閉じる" }));
    expect(document.activeElement).toBe(trigger);
    await act(async () => rejectRetry(new Error("Still unavailable")));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(trigger.getAttribute("aria-busy")).toBe("false");
  });

  it("also retries a failed separate window from the original sharing button", async () => {
    const p = {
      ...props(),
      activeViewModeId: "portrait",
      onOpenAuxiliary: vi
        .fn()
        .mockRejectedValueOnce(new Error("Unable to open controls"))
        .mockResolvedValueOnce(undefined),
    };
    render(<ScreenSharingControl {...p} />);
    const trigger = screen.getByRole("button", { name: "画面共有" });
    fireEvent.click(trigger);
    await screen.findByRole("alert");
    fireEvent.click(trigger);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(p.onOpenAuxiliary).toHaveBeenCalledTimes(2);
    expect(p.onStart).not.toHaveBeenCalled();
    expect(p.onStop).not.toHaveBeenCalled();
  });

  it("keeps marker OFF available during image delivery without stopping sharing", () => {
    const p = { ...props(), active: true, busy: true };
    const view = render(<ScreenSharingControl {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "画面共有中" }));
    fireEvent.click(screen.getByRole("switch", { name: "エージェントの指し示し（実験的）" }));
    expect(p.onPointersEnabledChange).toHaveBeenCalledExactlyOnceWith(false);
    expect(p.onStop).not.toHaveBeenCalled();
    view.rerender(<ScreenSharingControl {...p} pointersEnabled={false} pointersReady={false} />);
    const toggle = screen.getByRole("switch", {
      name: "エージェントの指し示し（実験的）",
    }) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
    expect(toggle.disabled).toBe(true);
  });
});
