// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import AuxiliaryScreenSharing from "./auxiliary-screen-sharing";
import {
  listenAuxiliarySnapshot,
  type PublishedAuxiliarySnapshot,
  readAuxiliarySnapshot,
  requestAuxiliaryAction,
} from "./runtime/auxiliary-windows";

vi.mock("./runtime/auxiliary-windows", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./runtime/auxiliary-windows")>()),
  listenAuxiliarySnapshot: vi.fn(),
  readAuxiliarySnapshot: vi.fn(),
  requestAuxiliaryAction: vi.fn(),
}));

const unlisten = vi.fn();
let receive: (state: PublishedAuxiliarySnapshot) => void = () => {};
let state: PublishedAuxiliarySnapshot;

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    version: 1,
    snapshot: {
      revision: "main-revision",
      pointerRevision: "pointer-revision",
      available: true,
      active: false,
      busy: false,
      pointersEnabled: true,
      pointersReady: true,
      sources: [
        { id: 1, name: "Display 1" },
        { id: 2, name: "Display 2" },
      ],
      sourceId: 1,
      screenSourceKind: "display",
      intervalSeconds: 30,
      contactSheetFrameCount: 16,
      hasError: false,
      lastObservedAt: null,
      language: "en",
    },
  };
  vi.mocked(listenAuxiliarySnapshot).mockImplementation(async (callback) => {
    receive = callback;
    return unlisten;
  });
  vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
  vi.mocked(requestAuxiliaryAction).mockResolvedValue(undefined);
});

afterEach(cleanup);

describe("independent screen-sharing controls", () => {
  it("turns motion off through the owner and hides the frame count", async () => {
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(
      await screen.findByRole("switch", { name: "Show motion with sequential frames" }),
    );
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, {
        type: "set-contact-sheet-frame-count",
        contactSheetFrameCount: 1,
      }),
    );
    state = { version: 2, snapshot: { ...state.snapshot, contactSheetFrameCount: 1 } };
    await act(async () => receive(state));
    expect(screen.queryByRole("slider", { name: "Frames to combine" })).toBeNull();
    fireEvent.click(screen.getByRole("switch", { name: "Show motion with sequential frames" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(2, {
        type: "set-contact-sheet-frame-count",
        contactSheetFrameCount: 16,
      }),
    );
  });

  it("commits the selected frame count rather than its slider index and applies the main theme", async () => {
    state = {
      ...state,
      snapshot: { ...state.snapshot, uiColors: { "--yorishiro-accent": "#dab878" } },
    };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    const slider = await screen.findByRole("slider", { name: "Frames to combine" });
    fireEvent.change(slider, { target: { value: "1" } });
    fireEvent.pointerUp(slider);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, {
        type: "set-contact-sheet-frame-count",
        contactSheetFrameCount: 9,
      }),
    );
    expect(document.documentElement.style.getPropertyValue("--yorishiro-accent")).toBe("#dab878");
    document.documentElement.style.removeProperty("--yorishiro-accent");
  });
  it("disables the action while region selection is pending", async () => {
    state = { ...state, snapshot: { ...state.snapshot, screenSourceKind: "region", busy: true } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    const selecting = await screen.findByRole("button", { name: "Selecting region…" });
    expect((selecting as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(selecting);
    fireEvent.click(selecting);
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
  });

  it("starts the first region drawing from Start without requiring a published rectangle", async () => {
    state = {
      ...state,
      snapshot: {
        ...state.snapshot,
        screenSourceKind: "region",
        region: null,
        pointersReady: false,
        sources: [],
        sourceId: null,
      },
    };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Start sharing" }));
    await waitFor(() => expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, { type: "start" }));
    expect(screen.queryByRole("button", { name: "Select region" })).toBeNull();
    expect(screen.queryByRole("switch", { name: "Agent pointing (experimental)" })).toBeNull();
  });

  it("routes screen source type changes through the owner", async () => {
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("tab", { name: "Window" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, {
        type: "select-screen-source-kind",
        screenSourceKind: "window",
      }),
    );
  });

  it("locks source modes while the active region frame stays adjustable on the desktop", async () => {
    state = { ...state, snapshot: { ...state.snapshot, screenSourceKind: "region", active: true } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    await screen.findByRole("tab", { name: "Area" });
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(screen.queryByRole("button", { name: "Select region" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reselect region" })).toBeNull();
    for (const tab of screen.getAllByRole("tab"))
      expect((tab as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps legacy display controls usable without offering unsupported source tabs", async () => {
    state = { ...state, snapshot: { ...state.snapshot, screenSourceKind: undefined } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Start sharing" }));
    expect(screen.queryByRole("tablist")).toBeNull();
    await waitFor(() => expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, { type: "start" }));
  });

  it("returns keyboard focus to the source chooser after Back", async () => {
    state = { ...state, snapshot: { ...state.snapshot, sourceKind: "screen" } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Share screen" }));
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Start sharing" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    const back = screen.getByRole("button", { name: "Back" });
    back.focus();
    fireEvent.click(back);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Share screen" })),
    );
  });

  it("requests camera preview visibility while sharing remains active", async () => {
    state = {
      ...state,
      snapshot: { ...state.snapshot, sourceKind: "camera", active: true, busy: true },
    };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Preview",
    })) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledExactlyOnceWith(state.version, {
        type: "set-preview-visible",
        visible: false,
      }),
    );
    act(() =>
      receive({
        ...state,
        version: state.version + 1,
        snapshot: { ...state.snapshot, previewVisible: false },
      }),
    );
    expect(toggle.checked).toBe(false);
  });
  it("shows source-selection failures while keeping the sharing menu available", async () => {
    state = { ...state, snapshot: { ...state.snapshot, sourceKind: "screen" } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    vi.mocked(requestAuxiliaryAction).mockRejectedValueOnce(new Error("Snapshot changed"));
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Share camera" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Snapshot changed");
    expect(screen.queryByRole("button", { name: "Start sharing" })).toBeNull();
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Share camera" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
  });

  it("selects camera through the shared menu and starts independently of screen pointers", async () => {
    state = { ...state, snapshot: { ...state.snapshot, sourceKind: "screen" } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    await screen.findByRole("button", { name: "Share camera" });
    fireEvent.click(screen.getByRole("button", { name: "Share camera" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, {
        type: "select-source-kind",
        sourceKind: "camera",
      }),
    );
    await act(async () =>
      receive({
        version: 2,
        snapshot: {
          ...state.snapshot,
          sourceKind: "camera",
          pointersReady: false,
          sources: [{ id: 9, name: "USB camera" }],
          sourceId: 9,
        },
      }),
    );
    expect(screen.getByLabelText("Camera")).toBeTruthy();
    const back = screen.getByRole("button", { name: "Back" });
    expect(back.textContent).toBe("");
    expect(back.querySelector("svg.lucide-undo-2")).not.toBeNull();
    expect(back.getAttribute("title")).toBe("Back");
    expect(back.nextElementSibling).toBe(screen.getByRole("heading", { name: "Camera sharing" }));
    expect(back.parentElement?.classList.contains("screen-sharing-heading")).toBe(true);
    expect(screen.queryByRole("switch", { name: "Agent pointing (experimental)" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    await waitFor(() => expect(requestAuxiliaryAction).toHaveBeenCalledWith(2, { type: "start" }));
  });

  it("sends rapid OFF and ON intents before a publication and restores published state on rejection", async () => {
    let rejectLatest!: (error: Error) => void;
    vi.mocked(requestAuxiliaryAction)
      .mockReturnValueOnce(new Promise(() => {}))
      .mockReturnValueOnce(
        new Promise((_resolve, reject) => {
          rejectLatest = reject;
        }),
      );
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Agent pointing (experimental)",
    })) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(true);
    expect(requestAuxiliaryAction).toHaveBeenNthCalledWith(
      1,
      1,
      { type: "set-pointers-enabled", enabled: false },
      "pointer-revision",
    );
    expect(requestAuxiliaryAction).toHaveBeenNthCalledWith(
      2,
      1,
      { type: "set-pointers-enabled", enabled: true },
      "pointer-revision",
    );
    const refreshed = { version: 2, snapshot: { ...state.snapshot, pointersEnabled: false } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(refreshed);
    await act(async () => rejectLatest(new Error("Snapshot changed")));
    expect(toggle.checked).toBe(false);
    expect(screen.getByRole("alert").textContent).toContain("Snapshot changed");
    expect(requestAuxiliaryAction).toHaveBeenCalledTimes(2);
  });

  it("requests recovery when initial marker synchronization failed", async () => {
    state = { ...state, snapshot: { ...state.snapshot, pointersReady: false, hasError: true } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    render(<AuxiliaryScreenSharing />);
    fireEvent.click(await screen.findByRole("button", { name: "Retry pointing setup" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(
        1,
        { type: "retry-pointers" },
        "pointer-revision",
      ),
    );
  });

  it("uses the main owner's state for start, stop, and another start", async () => {
    render(<AuxiliaryScreenSharing />);
    const start = await screen.findByRole("button", { name: "Start sharing" });
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.click(start);
    await waitFor(() => expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, { type: "start" }));
    state = { version: 2, snapshot: { ...state.snapshot, active: true } };
    await act(async () => receive(state));
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Stop sharing" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(2, { type: "stop" }),
    );
    state = { version: 3, snapshot: { ...state.snapshot, active: false } };
    await act(async () => receive(state));
    fireEvent.click(screen.getByRole("button", { name: "Start sharing" }));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(3, { type: "start" }),
    );
  });

  it("keeps keyboard focus during passive updates and commits a dragged interval once", async () => {
    render(<AuxiliaryScreenSharing />);
    const interval = (await screen.findByRole("slider", {
      name: "Send interval",
    })) as HTMLInputElement;
    expect(interval.min).toBe("10");
    expect(interval.max).toBe("180");
    expect(interval.value).toBe("30");
    interval.focus();
    state = {
      version: 2,
      snapshot: { ...state.snapshot, active: true, lastObservedAt: Date.now() },
    };
    await act(async () => receive(state));
    expect(document.activeElement).toBe(interval);
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.change(interval, { target: { value: "25" } });
    fireEvent.change(interval, { target: { value: "20" } });
    expect(requestAuxiliaryAction).not.toHaveBeenCalled();
    fireEvent.pointerUp(interval);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledExactlyOnceWith(2, {
        type: "set-interval",
        intervalSeconds: 20,
      }),
    );
  });

  it("selects and refreshes a stopped source, and disposes only its state listener when closed", async () => {
    const view = render(<AuxiliaryScreenSharing />);
    const select = await screen.findByRole("combobox", { name: "Display" });
    fireEvent.change(select, { target: { value: "2" } });
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenCalledWith(1, {
        type: "select-source",
        sourceId: 2,
      }),
    );
    await act(async () => {});
    fireEvent.pointerDown(screen.getByRole("combobox"));
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(1, { type: "refresh-sources" }),
    );
    const callsBeforeClose = vi.mocked(requestAuxiliaryAction).mock.calls.length;
    view.unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(requestAuxiliaryAction).toHaveBeenCalledTimes(callsBeforeClose);
  });

  it("can disable markers while capture and another control request are pending", async () => {
    state = { ...state, snapshot: { ...state.snapshot, active: true, busy: true } };
    vi.mocked(readAuxiliarySnapshot).mockResolvedValue(state);
    vi.mocked(requestAuxiliaryAction).mockReturnValueOnce(new Promise(() => {}));
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Agent pointing (experimental)",
    })) as HTMLInputElement;
    const interval = screen.getByRole("slider", { name: "Send interval" });
    fireEvent.change(interval, { target: { value: "20" } });
    fireEvent.pointerUp(interval);
    expect(toggle.disabled).toBe(false);
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(requestAuxiliaryAction).toHaveBeenLastCalledWith(
        1,
        { type: "set-pointers-enabled", enabled: false },
        "pointer-revision",
      ),
    );
    state = { version: 2, snapshot: { ...state.snapshot, pointersEnabled: false } };
    await act(async () => receive(state));
    expect(toggle.checked).toBe(false);
    expect(screen.getByRole("button", { name: "Stop sharing" })).toBeTruthy();
  });

  it("keeps pending OFF through capture updates and discards it when the pointer owner changes", async () => {
    vi.mocked(requestAuxiliaryAction).mockReturnValueOnce(new Promise(() => {}));
    render(<AuxiliaryScreenSharing />);
    const toggle = (await screen.findByRole("switch", {
      name: "Agent pointing (experimental)",
    })) as HTMLInputElement;
    fireEvent.click(toggle);
    expect(toggle.checked).toBe(false);
    state = {
      version: 2,
      snapshot: { ...state.snapshot, revision: "capture-revision", lastObservedAt: 1234 },
    };
    await act(async () => receive(state));
    expect(toggle.checked).toBe(false);
    expect(requestAuxiliaryAction).toHaveBeenCalledExactlyOnceWith(
      1,
      { type: "set-pointers-enabled", enabled: false },
      "pointer-revision",
    );
    state = {
      version: 3,
      snapshot: { ...state.snapshot, pointerRevision: "replacement-pointer-owner" },
    };
    await act(async () => receive(state));
    expect(toggle.checked).toBe(true);
  });
});
