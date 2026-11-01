// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuitySnapshot } from "../runtime/continuity/types";
import { ContinuityWorkspace, type ContinuityWorkspaceProps } from "./ContinuityWorkspace";

const native = vi.hoisted(() => ({
  useContinuity: vi.fn(),
  sendContinuityMessage: vi.fn(),
  actOnContinuityDraft: vi.fn(),
  retryContinuity: vi.fn(),
}));
vi.mock("../runtime/continuity/client", () => native);

const now = 1_795_000_000_000;
function snapshot(): ContinuitySnapshot {
  return {
    personaId: "yori",
    revision: 1,
    phase: "idle",
    error: null,
    lastObservedAt: now,
    messages: [
      {
        id: "legacy-1",
        role: "assistant",
        content: "以前の日記の全文",
        createdAt: now - 86_400_000,
        source: "legacy",
      },
      {
        id: "user-1",
        role: "user",
        content: "細かな改善より、体験全体から考えてほしい",
        createdAt: now,
        source: "conversation",
      },
      {
        id: "reply-1",
        role: "assistant",
        content: "起動したところから考え直してみる。",
        createdAt: now + 1,
        source: "conversation",
      },
    ],
    understandings: [
      {
        id: "preference-1",
        title: "進め方",
        value: "体験全体から考える",
        certainty: "confirmed",
        sourceIds: ["user-1"],
        updatedAt: now,
        revisions: [
          {
            value: "小さな改善を優先する",
            reason: "以前は変更の小ささを重視していた。",
            sourceIds: ["legacy-1"],
            createdAt: now - 86_400_000,
          },
        ],
      },
    ],
    reflections: [
      {
        id: "reflection-1",
        content: "変更の整理から、体験の設計へ考えを改めた。",
        sourceIds: ["user-1"],
        understandingIds: ["preference-1"],
        createdAt: now,
      },
      {
        id: "unrelated",
        content: "同じ日に見た別の作業",
        sourceIds: ["reply-1"],
        understandingIds: ["preference-1"],
        createdAt: now,
      },
    ],
    drafts: [
      {
        id: "draft-1",
        title: "起動から会話まで",
        content: "1. Yoriから話す\n2. 返事を受けて変わる\n<img src=x onerror=alert(1)>",
        reason: "体験から考えてほしいと聞いた。",
        sourceIds: ["reply-1"],
        status: "ready",
        createdAt: now + 1,
        updatedAt: now + 1,
      },
    ],
  };
}
let current: ContinuitySnapshot;
const originalShowModal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "showModal");
const originalClose = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "close");
const props = (): ContinuityWorkspaceProps => ({
  open: true,
  language: "ja",
  cwd: "/workspace",
  personaId: "yori-ja",
  personaName: "Yori",
  personaInstructions: "気になることを少し掘り下げる。",
  onClose: vi.fn(),
});
beforeEach(() => {
  current = snapshot();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
    key: (index: number) => Array.from(stored.keys())[index] ?? null,
    get length() {
      return stored.size;
    },
  } satisfies Storage);
  native.useContinuity.mockImplementation(() => ({ snapshot: current, error: null }));
  native.sendContinuityMessage.mockResolvedValue(undefined);
  native.actOnContinuityDraft.mockResolvedValue(undefined);
  native.retryContinuity.mockResolvedValue(undefined);
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, "close", {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
    },
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  for (const [method, descriptor] of [
    ["showModal", originalShowModal],
    ["close", originalClose],
  ] as const) {
    if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, method, descriptor);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, method);
  }
});

describe("ContinuityWorkspace", () => {
  it("shows real conversation and draft, and keeps imported diary material inside provenance", () => {
    render(<ContinuityWorkspace {...props()} />);
    const log = screen.getByRole("log");
    expect(log.textContent).toContain("起動したところから考え直してみる。");
    expect(log.textContent).not.toContain("以前の日記の全文");
    expect(screen.getByRole("heading", { name: "Yoriとの会話" })).toBeTruthy();
    expect(screen.queryByText("記憶と日記")).toBeNull();
    expect(screen.queryByText("任せたいこと")).toBeNull();
    expect(native.useContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: "yori-ja",
        cwd: "/workspace",
        personaPrompt: "気になることを少し掘り下げる。",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "いまの理解" }));
    const aside = screen.getByRole("complementary", { name: "いまの理解" });
    const details = within(aside).getByText("そう理解した経緯").closest("details");
    if (!details) throw new Error("Missing history");
    expect(details.open).toBe(false);
    fireEvent.click(within(aside).getByText("そう理解した経緯"));
    expect(details.open).toBe(true);
    expect(details.textContent).toContain("以前の日記の全文");
    expect(details.textContent).toContain("小さな改善を優先する");
    expect(details.textContent).toContain("変更の整理から、体験の設計へ考えを改めた。");
    expect(details.textContent).not.toContain("同じ日に見た別の作業");
  });

  it("preserves input across hiding and isolates different personas", () => {
    const initial = props();
    const view = render(<ContinuityWorkspace {...initial} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "書きかけ" } });
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(native.useContinuity).toHaveBeenLastCalledWith(
      expect.objectContaining({ personaId: "yori-ja" }),
    );
    view.rerender(<ContinuityWorkspace {...initial} open />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("書きかけ");
    view.rerender(<ContinuityWorkspace {...initial} personaId="yori" personaName="Another" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("heading", { name: "Anotherとの会話" })).toBeTruthy();
    view.rerender(<ContinuityWorkspace {...initial} personaId="yori-en" language="en" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("書きかけ");
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
  });

  it("sends actual corrections with their identity and retains open history during background updates", async () => {
    const view = render(<ContinuityWorkspace {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "いまの理解" }));
    fireEvent.click(screen.getByText("そう理解した経緯"));
    const disclosure = screen.getByText("そう理解した経緯").closest("details");
    if (!disclosure) throw new Error("Missing history");
    disclosure.querySelector("summary")?.focus();
    current = { ...current, revision: 2, phase: "thinking" };
    view.rerender(<ContinuityWorkspace {...props()} />);
    expect(disclosure.open).toBe(true);
    expect(document.activeElement).toBe(disclosure.querySelector("summary"));
    fireEvent.click(screen.getByRole("button", { name: "訂正する" }));
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe("体験全体から考える");
    fireEvent.change(input, { target: { value: "今日は調査を深めてほしい" } });
    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(native.sendContinuityMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ personaId: "yori-ja" }),
      "今日は調査を深めてほしい",
      "preference-1",
    );
    expect(input.value).toBe("");
  });

  it("leaves IME and a newer draft intact while an earlier send is being acknowledged", async () => {
    let finish!: () => void;
    native.sendContinuityMessage.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<ContinuityWorkspace {...props()} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "変換中" } });
    fireEvent.compositionStart(input);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.compositionEnd(input);
    fireEvent.keyDown(input, { key: "Enter", keyCode: 229 });
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "次の言葉" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(native.sendContinuityMessage).toHaveBeenCalledTimes(1);
    await act(async () => {
      finish();
    });
    expect((input as HTMLTextAreaElement).value).toBe("次の言葉");
  });

  it("retains failed input and shows a real retry error without inventing a reply", async () => {
    native.sendContinuityMessage.mockRejectedValueOnce(new Error("モデルに接続できません"));
    render(<ContinuityWorkspace {...props()} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "相談したいこと" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "送る" }));
    });
    expect(input.value).toBe("相談したいこと");
    expect(screen.getByRole("alert").textContent).toContain("モデルに接続できません");
    expect(screen.getByRole("log").textContent).not.toContain("相談したいこと");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "再試行" }));
    });
    expect(native.retryContinuity).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ personaId: "yori-ja" }),
    );
  });

  it("opens exact draft content safely and dispatches actions for that draft", async () => {
    native.actOnContinuityDraft.mockRejectedValueOnce(new Error("保存できません"));
    render(<ContinuityWorkspace {...props()} />);
    const opener = screen.getByRole("button", { name: "草案をひらく" });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(dialog.querySelector("img")).toBeNull();
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "見送る" }));
    });
    expect(native.actOnContinuityDraft).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ personaId: "yori-ja" }),
      "draft-1",
      "dismiss",
    );
    expect(within(dialog).getByRole("alert").textContent).toContain("保存できません");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "続きを考える" }));
    });
    expect(native.actOnContinuityDraft).toHaveBeenLastCalledWith(
      expect.anything(),
      "draft-1",
      "continue",
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("never starts voice on opening and keeps voice controls separate from native work", async () => {
    const conversation = {
      available: true,
      state: { status: "idle" as const },
      onStart: vi.fn().mockResolvedValue(undefined),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    };
    const initial = props();
    const view = render(<ContinuityWorkspace {...initial} conversation={conversation} />);
    expect(conversation.onStart).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "話しかける" }));
    });
    expect(conversation.onStart).toHaveBeenCalledOnce();
    view.rerender(
      <ContinuityWorkspace
        {...initial}
        conversation={{ ...conversation, state: { status: "active", microphoneMuted: false } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "ミュート" }));
    expect(conversation.onSetMuted).toHaveBeenCalledExactlyOnceWith(true);
    fireEvent.click(screen.getByRole("button", { name: "音声を終了" }));
    expect(conversation.onEnd).toHaveBeenCalledOnce();
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
    expect(native.actOnContinuityDraft).not.toHaveBeenCalled();
  });
});
