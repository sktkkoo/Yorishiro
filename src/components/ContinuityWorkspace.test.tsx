// @vitest-environment jsdom
import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuitySnapshot } from "../runtime/continuity/types";
import { ContinuityWorkspace, type ContinuityWorkspaceProps } from "./ContinuityWorkspace";

const setupNative = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => setupNative);
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
const piStatus = () => ({
  runtimeReady: true,
  configured: true,
  legacyConfiguration: false,
  authenticated: true,
  authentication: "present",
  model: "fixture-model",
  models: [{ id: "fixture-model", name: "Fixture" }],
  permissions: { read: true, write: false, commands: [] },
  workspaceAvailable: true,
  login: { phase: "idle", code: null },
  code: null,
});
const native = vi.hoisted(() => ({
  useContinuity: vi.fn(),
  sendContinuityMessage: vi.fn(),
  actOnContinuityDraft: vi.fn(),
  retryContinuity: vi.fn(),
  refreshContinuity: vi.fn(),
  setContinuityAutoEnabled: vi.fn(),
  forgetContinuityUnderstanding: vi.fn(),
}));
vi.mock("../runtime/continuity/client", () => native);

const now = 1_795_000_000_000;
function snapshot(): ContinuitySnapshot {
  return {
    personaId: "yori",
    autoEnabled: true,
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
function pendingQuestion(id = "pending-question"): ContinuitySnapshot["messages"][number] {
  return {
    id,
    role: "assistant",
    content: `Choose a direction: ${id}`,
    createdAt: now + 2,
    source: "conversation",
    replyKind: "awaitingReply",
  };
}
function pendingVoiceStart() {
  let resolve!: () => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<void>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
function readingLayout() {
  const layout = {
    height: 2000,
    detachedMeasurements: 0,
    items: new Map<string, { top: number; height: number }>([
      ["message:user-1", { top: 0, height: 100 }],
      ["message:reply-1", { top: 600, height: 700 }],
      ["draft:draft-1", { top: 1100, height: 200 }],
    ]),
  };
  vi.spyOn(Element.prototype, "scrollHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("continuity-flow") ? layout.height : 0;
  });
  vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(function (this: Element) {
    return this.classList.contains("continuity-flow") ? 400 : 0;
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    const bounds = (top: number, height: number) =>
      ({ top, bottom: top + height, height }) as DOMRect;
    if (this.classList.contains("continuity-flow")) {
      if (!this.isConnected) layout.detachedMeasurements += 1;
      return bounds(100, 400);
    }
    const item = layout.items.get(this.dataset.readingKey ?? "");
    const flow = this.closest<HTMLElement>(".continuity-flow");
    return item && flow ? bounds(100 + item.top - flow.scrollTop, item.height) : bounds(0, 0);
  });
  return layout;
}
const readingFlow = () => screen.getByRole("log").closest(".continuity-flow") as HTMLDivElement;
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
  vi.mocked(openUrl).mockReset().mockResolvedValue(undefined);
  setupNative.invoke.mockReset();
  setupNative.invoke.mockResolvedValue(piStatus());
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
  native.refreshContinuity.mockResolvedValue(undefined);
  native.setContinuityAutoEnabled.mockResolvedValue(undefined);
  native.forgetContinuityUnderstanding.mockResolvedValue(undefined);
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
  it.each([
    ["en", "Status and notices", "Send"],
    ["ja", "状態とお知らせ", "送る"],
  ] as const)("keeps complete %s errors in a keyboard-focusable region outside the message form", async (language, label, send) => {
    const reason = Array.from(
      { length: 20 },
      (_, index) => `Step ${index}: ${"x".repeat(20)}`,
    ).join("\n");
    current = { ...current, phase: "error", error: reason };
    render(<ContinuityWorkspace {...props()} language={language} />);
    const feedback = screen.getByRole("region", { name: label });
    expect(feedback.tabIndex).toBe(0);
    feedback.focus();
    expect(document.activeElement).toBe(feedback);
    expect(feedback.hasAttribute("aria-live")).toBe(false);
    expect(within(feedback).getByRole("alert").querySelector("p")?.textContent).toBe(reason);
    const input = screen.getByRole("textbox");
    const button = screen.getByRole("button", { name: send });
    expect(feedback.contains(input)).toBe(false);
    expect(feedback.contains(button)).toBe(false);
    fireEvent.change(input, { target: { value: "Actual message" } });
    await act(async () => fireEvent.click(button));
    expect(native.sendContinuityMessage).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      "Actual message",
      undefined,
    );
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it("groups simultaneous errors, diagnostics, reply navigation and correction context together", async () => {
    current = {
      ...current,
      phase: "error",
      error: "Work failure",
      messages: [...current.messages, pendingQuestion()],
    };
    setupNative.invoke.mockImplementation(async (name) => {
      if (name === "continuity_pi_diagnostics") throw new Error("configuration_missing");
      return piStatus();
    });
    const initial: ContinuityWorkspaceProps = {
      ...props(),
      language: "en",
      executionBackend: "pi",
      conversation: {
        available: true,
        state: { status: "error", error: "Voice failure" },
        onStart: vi.fn(),
        onEnd: vi.fn(),
        onSetMuted: vi.fn(),
      },
    };
    const view = render(<ContinuityWorkspace {...initial} />);
    await screen.findByRole("button", { name: "Check connection" });
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Check connection" })),
    );
    fireEvent.click(screen.getByRole("button", { name: "Memories" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    const flow = readingFlow();
    Object.defineProperties(flow, {
      scrollHeight: { configurable: true, value: 1600 },
      clientHeight: { configurable: true, value: 400 },
    });
    flow.scrollTop = 100;
    fireEvent.scroll(flow);
    current = {
      ...current,
      messages: [...current.messages, { ...pendingQuestion("new-report"), replyKind: "report" }],
    };
    view.rerender(<ContinuityWorkspace {...initial} />);
    const feedback = screen.getByRole("region", { name: "Status and notices" });
    expect(within(feedback).getAllByRole("alert")).toHaveLength(2);
    expect(feedback.textContent).toContain("Work failure");
    expect(feedback.textContent).toContain("Voice failure");
    expect(within(feedback).getByRole("status").textContent).toContain(
      "Pi connection settings are missing.",
    );
    for (const name of [
      "View question",
      "New reply",
      "Cancel correction",
      "Retry",
      "Check connection",
    ])
      expect(within(feedback).getByRole("button", { name })).toBeTruthy();
    expect(feedback.contains(screen.getByRole("textbox"))).toBe(false);
    expect(native.retryContinuity).not.toHaveBeenCalled();
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
  });

  it("does not leave an empty focusable feedback region when notices are absent or suppressed", async () => {
    current = { ...current, autoEnabled: false };
    const view = render(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.queryByRole("region", { name: "Status and notices" })).toBeNull();
    current = { ...current, phase: "error", error: "Work failure" };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.getByRole("region", { name: "Status and notices" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
    expect(screen.queryByRole("region", { name: "Status and notices" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    setupNative.invoke.mockResolvedValue({ ...piStatus(), configured: false });
    view.rerender(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "Status and notices" })).toBeNull(),
    );
  });

  it("opens literal report and draft result links without submitting or changing autonomous work", async () => {
    const report = "PR: https://github.com/team/repo/pull/12。\nReady for review.";
    const draft = "Details:\nhttps://example.com/result_(one).";
    current = {
      ...current,
      messages: [{ ...current.messages[2], content: report, replyKind: "report" }],
      drafts: [{ ...current.drafts[0], content: draft }],
    };
    render(<ContinuityWorkspace {...props()} language="en" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent reply" } });
    const reportLink = screen.getByRole("link", { name: "https://github.com/team/repo/pull/12" });
    expect(reportLink.closest("p")?.textContent).toBe(report);
    expect(openUrl).not.toHaveBeenCalled();
    await act(async () => fireEvent.click(reportLink));
    fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
    const dialog = screen.getByRole("dialog");
    const draftLink = within(dialog).getByRole("link", {
      name: "https://example.com/result_(one)",
    });
    expect(draftLink.closest(".continuity-draft-body")?.textContent).toBe(draft);
    await act(async () => fireEvent.click(draftLink));
    expect(openUrl).toHaveBeenNthCalledWith(1, "https://github.com/team/repo/pull/12");
    expect(openUrl).toHaveBeenNthCalledWith(2, "https://example.com/result_(one)");
    expect((dialog as HTMLDialogElement).open).toBe(true);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent reply");
    for (const command of [
      native.sendContinuityMessage,
      native.actOnContinuityDraft,
      native.retryContinuity,
      native.refreshContinuity,
      native.setContinuityAutoEnabled,
      native.forgetContinuityUnderstanding,
    ])
      expect(command).not.toHaveBeenCalled();
  });

  it("keeps opener failure feedback separate from existing work errors and retries the same URL", async () => {
    current = {
      ...current,
      phase: "error",
      error: "Worker unavailable",
      messages: [{ ...current.messages[2], content: "Result: https://example.com/report。" }],
    };
    vi.mocked(openUrl).mockRejectedValueOnce(new Error("Opener unavailable"));
    render(<ContinuityWorkspace {...props()} language="en" />);
    const link = screen.getByRole("link", { name: "https://example.com/report" });
    await act(async () => fireEvent.click(link));
    expect(screen.getByText("Worker unavailable")).toBeTruthy();
    expect(screen.getByText("Could not open the link. Try it again or copy the URL.")).toBeTruthy();
    await act(async () => fireEvent.click(link));
    expect(screen.getByText("Worker unavailable")).toBeTruthy();
    expect(screen.queryByText("Could not open the link. Try it again or copy the URL.")).toBeNull();
    expect(openUrl).toHaveBeenCalledTimes(2);
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });
  it.each([
    ["ja", "考えています", "草案を作成中", "作業中", "待機中"],
    ["en", "Thinking", "Preparing a draft", "Working", "Idle"],
  ] as const)("keeps native activity beside the composer in %s, including work finishing while Off", (language, thinking, drafting, working, idle) => {
    const view = render(<ContinuityWorkspace {...props()} language={language} />);
    const state = screen.getByRole("status");
    expect(state.textContent).toBe(idle);
    expect(state.closest(".continuity-compose-area")).not.toBeNull();
    expect(state.closest(".continuity-flow")).toBeNull();
    expect(state.querySelector("svg")).toBeNull();
    for (const [phase, label] of [
      ["thinking", thinking],
      ["drafting", drafting],
      ["working", working],
    ] as const) {
      for (const autoEnabled of [true, false]) {
        current = { ...current, phase, autoEnabled };
        view.rerender(<ContinuityWorkspace {...props()} language={language} />);
        expect(screen.getAllByRole("status")).toHaveLength(1);
        expect(screen.getByRole("status").textContent).toBe(label);
        expect(screen.getByRole("status").querySelector("svg")).not.toBeNull();
      }
    }
    current = { ...current, phase: "idle", autoEnabled: false };
    view.rerender(<ContinuityWorkspace {...props()} language={language} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(native.retryContinuity).not.toHaveBeenCalled();
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
  });

  it.each([
    "ja",
    "en",
  ] as const)("shows loading outside the conversation until native state arrives in %s", (language) => {
    native.useContinuity.mockReturnValue({ snapshot: null, error: null });
    const view = render(<ContinuityWorkspace {...props()} language={language} />);
    expect(screen.getByRole("status").textContent).toBe(
      language === "ja" ? "読み込み中" : "Loading",
    );
    expect(screen.getByRole("status").closest(".continuity-flow")).toBeNull();
    native.useContinuity.mockReturnValue({ snapshot: null, error: "Could not load state" });
    view.rerender(<ContinuityWorkspace {...props()} language={language} />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Could not load state");
  });

  it("does not call an errored or unknown execution state idle", () => {
    const view = render(<ContinuityWorkspace {...props()} language="en" />);
    for (const state of [
      { ...snapshot(), phase: "error" as const },
      { ...snapshot(), error: "Could not finish work" },
      { ...snapshot(), autoEnabled: undefined },
    ]) {
      current = state;
      view.rerender(<ContinuityWorkspace {...props()} language="en" />);
      expect(screen.queryByRole("status")).toBeNull();
    }
    native.useContinuity.mockReturnValue({ snapshot: snapshot(), error: "Could not sync state" });
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Could not sync state");
  });

  it("waits for Pi setup before showing idle, while still showing accepted work", async () => {
    let finish!: (value: ReturnType<typeof piStatus>) => void;
    setupNative.invoke.mockImplementation(
      () =>
        new Promise<ReturnType<typeof piStatus>>((resolve) => {
          finish = resolve;
        }),
    );
    const view = render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    expect(screen.queryByText("Idle")).toBeNull();
    await act(async () => finish(piStatus()));
    await screen.findByText("Idle");
    setupNative.invoke.mockResolvedValue({ ...piStatus(), configured: false });
    view.rerender(
      <ContinuityWorkspace {...props()} language="en" executionBackend="pi" cwd="/other" />,
    );
    expect(screen.queryByText("Idle")).toBeNull();
    await screen.findByText("Check connection settings");
    current = { ...current, phase: "working", autoEnabled: false };
    view.rerender(
      <ContinuityWorkspace {...props()} language="en" executionBackend="pi" cwd="/other" />,
    );
    expect(screen.getByRole("status").textContent).toBe("Working");
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it.each([
    ["ja", "返答を求めています", "質問を見る", "作業中"],
    ["en", "Reply requested", "View question", "Working"],
  ] as const)("finds and focuses the latest unanswered %s question without changing the draft or work", (language, cue, viewQuestion, activity) => {
    current = {
      ...current,
      phase: "working",
      messages: [
        ...current.messages,
        pendingQuestion("older-question"),
        pendingQuestion(),
        {
          ...pendingQuestion("report"),
          replyKind: "report",
          content: "Independent work completed",
        },
      ],
    };
    render(<ContinuityWorkspace {...props()} language={language} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "My unsent answer" } });
    const button = screen.getByRole("button", { name: viewQuestion });
    const target = screen.getByRole("article", { name: cue });
    const flow = screen.getByRole("log").closest(".continuity-flow") as HTMLElement;
    expect(button.getAttribute("aria-controls")).toBe(target.id);
    expect(target.textContent).toContain("Choose a direction: pending-question");
    vi.spyOn(flow, "getBoundingClientRect").mockReturnValue({ top: 100 } as DOMRect);
    vi.spyOn(target, "getBoundingClientRect").mockReturnValue({ top: 320 } as DOMRect);
    flow.scrollTop = 150;
    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(document.activeElement).toBe(target);
    expect(target.tabIndex).toBe(-1);
    expect(flow.scrollTop).toBe(362);
    expect(input).toHaveProperty("value", "My unsent answer");
    expect(screen.getByRole("status").textContent).toBe(activity);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    for (const command of [
      native.sendContinuityMessage,
      native.actOnContinuityDraft,
      native.retryContinuity,
      native.refreshContinuity,
      native.setContinuityAutoEnabled,
      native.forgetContinuityUnderstanding,
    ])
      expect(command).not.toHaveBeenCalled();
  });

  it("keeps the question discoverable until a user reply is recorded, including a failed send", async () => {
    current = { ...current, messages: [...current.messages, pendingQuestion()] };
    const view = render(<ContinuityWorkspace {...props()} language="en" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent answer" } });
    expect(screen.getByRole("button", { name: "View question" })).toBeTruthy();
    native.sendContinuityMessage.mockRejectedValueOnce(new Error("Could not save answer"));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(screen.getByRole("button", { name: "View question" })).toBeTruthy();
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent answer");
    current = {
      ...current,
      messages: [
        ...current.messages,
        {
          ...pendingQuestion("recorded-reply"),
          role: "user",
          source: "voice",
          replyKind: null,
          content: "Recorded answer",
        },
      ],
    };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.queryByRole("button", { name: "View question" })).toBeNull();
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent answer");
  });

  it.each([
    [{ ...pendingQuestion(), replyKind: undefined }],
    [{ ...pendingQuestion(), replyKind: null }],
    [{ ...pendingQuestion(), replyKind: "report" as const }],
    [{ ...pendingQuestion(), source: "legacy" as const }],
    [pendingQuestion(), { ...pendingQuestion("answered"), role: "user" as const }],
  ])("does not infer pending questions from old metadata, legacy content or answered messages", (...messages) => {
    current = { ...current, messages: [...current.messages, ...messages] };
    render(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.queryByRole("button", { name: "View question" })).toBeNull();
  });

  it("ignores legacy user text as an answer and scopes pending questions to the selected persona", () => {
    current = {
      ...current,
      messages: [
        ...current.messages,
        pendingQuestion(),
        { ...pendingQuestion("legacy-user"), role: "user", source: "legacy" },
      ],
    };
    const view = render(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.getByRole("button", { name: "View question" })).toBeTruthy();
    current = snapshot();
    view.rerender(<ContinuityWorkspace {...props()} language="en" personaId="another-persona" />);
    expect(screen.queryByRole("button", { name: "View question" })).toBeNull();
  });

  it("preserves reading position and unread reports while focused on a question, then follows the latest reply on request", () => {
    current = { ...current, messages: [...current.messages, pendingQuestion()] };
    const view = render(<ContinuityWorkspace {...props()} language="en" />);
    const flow = screen.getByRole("log").closest(".continuity-flow") as HTMLElement;
    Object.defineProperties(flow, {
      scrollHeight: { configurable: true, value: 800 },
      clientHeight: { configurable: true, value: 400 },
    });
    flow.scrollTop = 400;
    fireEvent.click(screen.getByRole("button", { name: "View question" }));
    const readingPosition = flow.scrollTop;
    fireEvent.scroll(flow);
    current = {
      ...current,
      messages: [...current.messages, { ...pendingQuestion("report-1"), replyKind: "report" }],
    };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(flow.scrollTop).toBe(readingPosition);
    expect(document.activeElement).toBe(screen.getByRole("article", { name: "Reply requested" }));
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
    fireEvent.scroll(flow);
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "View question" }));
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New reply" }));
    expect(flow.scrollTop).toBe(800);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
    current = {
      ...current,
      messages: [...current.messages, { ...pendingQuestion("report-2"), replyKind: "report" }],
    };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
    expect(screen.getByRole("button", { name: "View question" })).toBeTruthy();
  });

  it("restores the message being read after hidden arrivals and reflow, without adopting a lower visible draft", () => {
    const layout = readingLayout();
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    readingFlow().scrollTop = 750;
    fireEvent.scroll(readingFlow());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent reply" } });
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    expect(layout.detachedMeasurements).toBe(0);
    current = {
      ...current,
      messages: [
        ...current.messages.slice(1),
        { ...pendingQuestion("new-report"), replyKind: "report" },
      ],
    };
    layout.items.set("message:reply-1", { top: 450, height: 1050 });
    layout.items.set("draft:draft-1", { top: 1300, height: 200 });
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(600);
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent reply");
    readingFlow().scrollTop = 650;
    fireEvent.scroll(readingFlow());
    current = { ...current, phase: "working", revision: 2 };
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(650);
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
    expect(native.actOnContinuityDraft).not.toHaveBeenCalled();
  });

  it("anchors the draft at the reading edge independently from its same-id enclosing message", () => {
    const layout = readingLayout();
    current = { ...current, drafts: [{ ...current.drafts[0], id: "reply-1" }] };
    layout.items.set("draft:reply-1", { top: 1100, height: 200 });
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    readingFlow().scrollTop = 1120;
    fireEvent.scroll(readingFlow());
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    layout.items.set("message:reply-1", { top: 100, height: 1300 });
    layout.items.set("draft:reply-1", { top: 1200, height: 200 });
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(1220);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
  });

  it("clamps the fallback when a retained anchor disappears without treating restore as reading new replies", () => {
    const layout = readingLayout();
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    readingFlow().scrollTop = 750;
    fireEvent.scroll(readingFlow());
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    current = {
      ...current,
      messages: [{ ...pendingQuestion("retained"), replyKind: "report" }],
      drafts: [],
    };
    layout.height = 500;
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(100);
    fireEvent.scroll(readingFlow());
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
    current = {
      ...current,
      messages: [...current.messages, { ...pendingQuestion("later"), replyKind: "report" }],
    };
    layout.height = 800;
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "New reply" }));
    expect(readingFlow().scrollTop).toBe(800);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
  });

  it("continues bottom-follow on reopen and starts a different persona independently", () => {
    const layout = readingLayout();
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    readingFlow().scrollTop = 1600;
    fireEvent.scroll(readingFlow());
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    current = { ...current, messages: [...current.messages, pendingQuestion("new-question")] };
    layout.height = 2400;
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(2400);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
    readingFlow().scrollTop = 750;
    fireEvent.scroll(readingFlow());
    view.rerender(<ContinuityWorkspace {...initial} personaId="other-persona" />);
    expect(readingFlow().scrollTop).toBe(2400);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
  });

  it("reopens at a requested question even near the bottom and preserves hidden report notifications", () => {
    const layout = readingLayout();
    current = { ...current, messages: [...current.messages, pendingQuestion()] };
    layout.items.set("message:pending-question", { top: 1550, height: 100 });
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    fireEvent.click(screen.getByRole("button", { name: "View question" }));
    expect(readingFlow().scrollTop).toBe(1542);
    fireEvent.scroll(readingFlow());
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    current = {
      ...current,
      messages: [...current.messages, { ...pendingQuestion("new-report"), replyKind: "report" }],
    };
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(1542);
    fireEvent.scroll(readingFlow());
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
  });

  it("lets an explicit send follow the latest conversation instead of restoring the older reading position", async () => {
    readingLayout();
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    readingFlow().scrollTop = 750;
    fireEvent.scroll(readingFlow());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Continue here" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    current = {
      ...current,
      messages: [...current.messages, { ...pendingQuestion("sent"), role: "user" }],
    };
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(readingFlow().scrollTop).toBe(2000);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
    expect(native.sendContinuityMessage).toHaveBeenCalledTimes(1);
  });

  it("updates activity without scrolling older replies, losing input, or clearing unread replies", () => {
    const view = render(<ContinuityWorkspace {...props()} language="en" />);
    const flow = screen.getByRole("log").closest(".continuity-flow") as HTMLElement;
    Object.defineProperties(flow, {
      scrollHeight: { configurable: true, value: 1600 },
      clientHeight: { configurable: true, value: 400 },
    });
    flow.scrollTop = 300;
    fireEvent.scroll(flow);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Still composing" } });
    current = { ...current, phase: "working", revision: 2 };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.getByRole("status").textContent).toBe("Working");
    expect(flow.scrollTop).toBe(300);
    expect(screen.queryByRole("button", { name: "New reply" })).toBeNull();
    current = {
      ...current,
      revision: 3,
      messages: [
        ...current.messages,
        {
          id: "new-reply",
          role: "assistant",
          content: "A completed result",
          createdAt: now + 2,
          source: "conversation",
        },
      ],
    };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
    current = { ...current, phase: "idle", revision: 4 };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.getByRole("status").textContent).toBe("Idle");
    expect(flow.scrollTop).toBe(300);
    expect(screen.getByRole("button", { name: "New reply" })).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Still composing");
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
    expect(native.actOnContinuityDraft).not.toHaveBeenCalled();
    expect(native.retryContinuity).not.toHaveBeenCalled();
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
  });

  it.each([
    ["ja", "設定", "メモリー", "設定を閉じる", "設定を保存して自律実行に使用"],
    ["en", "Settings", "Memories", "Close settings", "Save and use for autonomous execution"],
  ] as const)("opens compact settings beside memories and saves without enabling autonomy in %s", async (language, settings, memories, close, save) => {
    current = { ...current, autoEnabled: false };
    render(<ContinuityWorkspace {...props()} language={language} executionBackend="pi" />);
    const button = screen.getByRole("button", { name: settings });
    expect(screen.getByRole("button", { name: memories }).parentElement).toBe(
      button.parentElement?.parentElement,
    );
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(button.getAttribute("aria-controls") ?? "")).toHaveProperty(
      "hidden",
      true,
    );
    expect(screen.queryByRole("combobox")).toBeNull();
    expect(
      screen.queryByText(
        /自律実行の接続と権限|Autonomous execution connection and permissions|設定済み|Configured/,
      ),
    ).toBeNull();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hello" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: language === "ja" ? "送る" : "Send" }),
      ).toHaveProperty("disabled", false),
    );
    fireEvent.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: close }));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByRole("button", { name: save }));
    await waitFor(() => expect(button.getAttribute("aria-expanded")).toBe("false"));
    expect(document.activeElement).toBe(button);
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it("does not steal focus or restart work when a pending save finishes after closing and turning Off", async () => {
    let finish!: (value: ReturnType<typeof piStatus>) => void;
    setupNative.invoke.mockImplementation((command) =>
      command === "continuity_pi_setup_save"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(piStatus()),
    );
    const view = render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const save = await screen.findByRole("button", {
      name: "Save and use for autonomous execution",
    });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);
    fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
    current = { ...current, autoEnabled: false };
    view.rerender(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    const input = screen.getByRole("textbox");
    input.focus();
    await act(async () => finish(piStatus()));
    expect(document.activeElement).toBe(input);
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    expect(native.retryContinuity).not.toHaveBeenCalled();
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
  });

  it("ignores old workspace save completion after switching to another workspace", async () => {
    let finish!: (value: ReturnType<typeof piStatus>) => void;
    setupNative.invoke.mockImplementation((command) =>
      command === "continuity_pi_setup_save"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(piStatus()),
    );
    const view = render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const save = await screen.findByRole("button", {
      name: "Save and use for autonomous execution",
    });
    await waitFor(() => expect(save).toHaveProperty("disabled", false));
    fireEvent.click(save);
    view.rerender(
      <ContinuityWorkspace {...props()} language="en" executionBackend="pi" cwd="/other" />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await screen.findByRole("combobox");
    await act(async () => finish(piStatus()));
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(screen.getByText("other")).toBeTruthy();
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it("closes settings and resets unsaved grants when switching workspace or persona", async () => {
    const view = render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Create and change files" }));
    view.rerender(
      <ContinuityWorkspace {...props()} language="en" executionBackend="pi" cwd="/other" />,
    );
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await waitFor(() =>
      expect(screen.getByRole("checkbox", { name: "Create and change files" })).toHaveProperty(
        "checked",
        false,
      ),
    );
    view.rerender(
      <ContinuityWorkspace
        {...props()}
        language="en"
        executionBackend="pi"
        cwd="/other"
        personaId="custom"
      />,
    );
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-expanded")).toBe(
      "false",
    );
  });

  it("shows a settings hint for unconfigured or failed connections while the panel stays closed", async () => {
    setupNative.invoke.mockResolvedValue({ ...piStatus(), configured: false });
    const view = render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    await screen.findByText("Check connection settings");
    const button = screen.getByRole("button", { name: "Settings" });
    expect(
      document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent,
    ).toBe("Check connection settings");
    expect(button.getAttribute("aria-expanded")).toBe("false");
    view.rerender(
      <ContinuityWorkspace {...props()} language="en" executionBackend="pi" personaId="yori-en" />,
    );
    expect(screen.getByText("Check connection settings")).toBeTruthy();
    setupNative.invoke.mockRejectedValue("setup_unavailable");
    fireEvent(window, new Event("focus"));
    fireEvent.click(button);
    await screen.findByRole("alert");
  });

  it.each([
    "ja",
    "en",
  ] as const)("shows Off on the %s switch without repeating an idle Off sentence", (language) => {
    current = { ...current, autoEnabled: false };
    const view = render(<ContinuityWorkspace {...props()} language={language} />);
    const control = screen.getByRole("switch");
    expect(control.getAttribute("aria-checked")).toBe("false");
    expect(control.textContent).toContain("Off");
    expect(control.hasAttribute("aria-describedby")).toBe(false);
    expect(screen.queryByText("自律実行はOffです。")).toBeNull();
    expect(screen.queryByText("Autonomous execution is Off.")).toBeNull();
    current = { ...current, phase: "working" };
    view.rerender(<ContinuityWorkspace {...props()} language={language} />);
    const description = control.getAttribute("aria-describedby");
    expect(description).toBeTruthy();
    expect(document.getElementById(description ?? "")?.textContent).toBe(
      language === "ja"
        ? "進行中の作業が完了したら停止します。"
        : "The current work will finish before stopping.",
    );
  });

  it.each([
    ["ja", "メモリー", "忘れる", "キャンセル"],
    ["en", "Memories", "Forget", "Cancel"],
  ] as const)("confirms memory-only forgetting accessibly in %s and allows cancellation", (language, memories, forget, cancel) => {
    current = { ...current, autoEnabled: false };
    render(<ContinuityWorkspace {...props()} language={language} />);
    fireEvent.click(screen.getByRole("button", { name: memories }));
    const opener = screen.getByRole("button", { name: `${forget} · 進め方` });
    opener.focus();
    fireEvent.click(opener);
    const dialog = screen.getByRole("dialog");
    expect(dialog.getAttribute("aria-labelledby")).toBeTruthy();
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(dialog.textContent).toContain("体験全体から考える");
    expect(dialog.textContent).toContain(
      language === "ja" ? "元の会話は削除しません" : "does not delete the original conversation",
    );
    expect(dialog.textContent).toContain(
      language === "ja" ? "すでに渡した内容は消去されません" : "already sent to an AI",
    );
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: cancel }));
    fireEvent.click(within(dialog).getByRole("button", { name: cancel }));
    expect(native.forgetContinuityUnderstanding).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("waits for confirmed forgetting once, preserves conversation, clears the deleted correction and restores focus", async () => {
    let finish!: () => void;
    native.forgetContinuityUnderstanding.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    current = { ...current, autoEnabled: false };
    const view = render(<ContinuityWorkspace {...props()} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "通常の書きかけ" } });
    fireEvent.click(screen.getByRole("button", { name: "メモリー" }));
    fireEvent.click(screen.getByRole("button", { name: "訂正する" }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("体験全体から考える");
    fireEvent.click(screen.getByRole("button", { name: "メモリー" }));
    fireEvent.click(screen.getByRole("button", { name: "忘れる · 進め方" }));
    const dialog = screen.getByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "忘れる" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(native.forgetContinuityUnderstanding).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ personaId: "yori-ja" }),
      "preference-1",
    );
    expect(current.understandings).toHaveLength(1);
    expect(within(dialog).getByRole("button", { name: "削除中…" }).hasAttribute("disabled")).toBe(
      true,
    );
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    const messages = current.messages;
    await act(async () => {
      current = { ...current, revision: 2, understandings: [] };
      finish();
    });
    view.rerender(<ContinuityWorkspace {...props()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: "忘れる · 進め方" })).toBeNull();
    expect(current.messages).toBe(messages);
    expect(screen.getByRole("log").textContent).toContain(
      "細かな改善より、体験全体から考えてほしい",
    );
    expect(screen.queryByRole("button", { name: "訂正をやめる" })).toBeNull();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("通常の書きかけ");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "メモリーを閉じる" }));
  });

  it("forgetting an inactive correction preserves the current correction and normal draft", async () => {
    current = {
      ...current,
      understandings: [
        ...current.understandings,
        {
          ...current.understandings[0],
          id: "preference-2",
          title: "Second memory",
          value: "Memory B",
        },
      ],
    };
    render(<ContinuityWorkspace {...props()} language="en" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Normal draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Memories" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Correct" })[0]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited A" } });
    fireEvent.click(screen.getByRole("button", { name: "Memories" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Correct" })[1]);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited B" } });
    fireEvent.click(screen.getByRole("button", { name: "Memories" }));
    fireEvent.click(screen.getByRole("button", { name: "Forget · 進め方" }));
    await act(async () =>
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Forget" })),
    );
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Edited B");
    const saved = JSON.parse(
      localStorage.getItem("yorishiro.continuity.input.builtin%3Ayori") ?? "null",
    );
    expect(saved.corrections).toEqual({ "preference-2": "Edited B" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel correction" }));
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Normal draft");
  });

  it("keeps a failed forget visible and allows retry without starting autonomous work", async () => {
    native.forgetContinuityUnderstanding.mockRejectedValueOnce(new Error("保存できません"));
    const view = render(<ContinuityWorkspace {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "メモリー" }));
    fireEvent.click(screen.getByRole("button", { name: "忘れる · 進め方" }));
    const dialog = screen.getByRole("dialog");
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "忘れる" })));
    current = { ...current, revision: current.revision + 1, error: null };
    view.rerender(<ContinuityWorkspace {...props()} />);
    expect(within(dialog).getByRole("alert").textContent).toContain("保存できません");
    expect(current.understandings).toHaveLength(1);
    await act(async () => fireEvent.click(within(dialog).getByRole("button", { name: "忘れる" })));
    expect(native.forgetContinuityUnderstanding).toHaveBeenCalledTimes(2);
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
    expect(native.retryContinuity).not.toHaveBeenCalled();
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows concurrent edits in the forget confirmation and closes safely if the memory disappears", () => {
    const view = render(<ContinuityWorkspace {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "メモリー" }));
    fireEvent.click(screen.getByRole("button", { name: "忘れる · 進め方" }));
    current = {
      ...current,
      revision: 2,
      understandings: current.understandings.map((item) => ({ ...item, value: "更新後の内容" })),
    };
    view.rerender(<ContinuityWorkspace {...props()} />);
    expect(screen.getByRole("dialog").textContent).toContain("更新後の内容");
    current = { ...current, revision: 3, understandings: [] };
    view.rerender(<ContinuityWorkspace {...props()} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(native.forgetContinuityUnderstanding).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "メモリーを閉じる" }));
  });

  it("changes autonomous execution through the native setting and preserves Off on reopening", async () => {
    let finish!: () => void;
    native.setContinuityAutoEnabled.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const initial = props();
    const view = render(<ContinuityWorkspace {...initial} />);
    const control = screen.getByRole("switch", { name: "自律実行" });
    expect(control.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(control);
    fireEvent.click(control);
    expect(native.setContinuityAutoEnabled).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ personaId: "yori-ja", cwd: "/workspace" }),
      false,
    );
    expect(control.getAttribute("aria-checked")).toBe("true");
    expect((control as HTMLButtonElement).disabled).toBe(true);
    current = { ...current, revision: 2, autoEnabled: false };
    await act(async () => finish());
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(control.getAttribute("aria-checked")).toBe("false");
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
    await act(async () => fireEvent.click(screen.getByRole("switch")));
    expect(native.setContinuityAutoEnabled).toHaveBeenLastCalledWith(
      expect.objectContaining({ personaId: "yori-ja" }),
      true,
    );
  });

  it("keeps the saved switch state and shows a setting failure", async () => {
    native.setContinuityAutoEnabled.mockRejectedValueOnce(new Error("Could not save setting"));
    render(<ContinuityWorkspace {...props()} />);
    await act(async () => fireEvent.click(screen.getByRole("switch")));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("Could not save setting");
  });

  it("does not offer an active switch before the host setting is available", () => {
    current = { ...current, autoEnabled: undefined };
    render(<ContinuityWorkspace {...props()} />);
    expect((screen.getByRole("switch") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("switch"));
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
  });

  it("shows real conversation and draft, and keeps imported diary material inside provenance", () => {
    render(<ContinuityWorkspace {...props()} />);
    const log = screen.getByRole("log");
    expect(log.textContent).toContain("起動したところから考え直してみる。");
    expect(log.textContent).not.toContain("以前の日記の全文");
    expect(screen.getByRole("heading", { name: "自律実行" })).toBeTruthy();
    expect(screen.queryByText("記憶と日記")).toBeNull();
    expect(screen.queryByText("任せたいこと")).toBeNull();
    expect(native.useContinuity).toHaveBeenCalledWith(
      expect.objectContaining({
        personaId: "yori-ja",
        cwd: "/workspace",
        personaPrompt: "気になることを少し掘り下げる。",
      }),
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "メモリー" }));
    const aside = screen.getByRole("complementary", { name: "メモリー" });
    const details = within(aside).getByText("更新履歴").closest("details");
    if (!details) throw new Error("Missing history");
    expect(details.open).toBe(false);
    fireEvent.click(within(aside).getByText("更新履歴"));
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
      false,
    );
    view.rerender(<ContinuityWorkspace {...initial} open />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("書きかけ");
    view.rerender(<ContinuityWorkspace {...initial} personaId="yori" personaName="Another" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
    expect(screen.getByRole("heading", { name: "自律実行" })).toBeTruthy();
    view.rerender(<ContinuityWorkspace {...initial} personaId="yori-en" language="en" />);
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("書きかけ");
    expect(native.sendContinuityMessage).not.toHaveBeenCalled();
  });

  it("sends actual corrections with their identity and retains open history during background updates", async () => {
    const view = render(<ContinuityWorkspace {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "メモリー" }));
    fireEvent.click(screen.getByText("更新履歴"));
    const disclosure = screen.getByText("更新履歴").closest("details");
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

  it("keeps normal and per-memory drafts across switching, cancellation, persistence and persona changes", async () => {
    current = {
      ...current,
      understandings: [
        ...current.understandings,
        {
          ...current.understandings[0],
          id: "preference-2",
          title: "Second memory",
          value: "Memory B",
        },
      ],
    };
    const initial = { ...props(), language: "en" as const };
    const choose = (title: string) => {
      fireEvent.click(screen.getByRole("button", { name: "Memories" }));
      const card = screen.getByRole("heading", { name: title }).closest("article");
      if (!card) throw new Error("Missing memory");
      fireEvent.click(within(card).getByRole("button", { name: "Correct" }));
    };
    const view = render(<ContinuityWorkspace {...initial} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent normal request" } });
    choose("進め方");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "体験全体から考える");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited A" } });
    choose("Second memory");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Memory B");
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "" } });
    choose("進め方");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Edited A");
    fireEvent.click(screen.getByRole("button", { name: "Cancel correction" }));
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent normal request");
    view.unmount();
    const remounted = render(<ContinuityWorkspace {...initial} personaId="another-persona" />);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    remounted.rerender(<ContinuityWorkspace {...initial} personaId="yori-en" />);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent normal request");
    choose("Second memory");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    expect(screen.getByRole("button", { name: "Send" })).toHaveProperty("disabled", true);
    choose("進め方");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(native.sendContinuityMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ personaId: "yori-en" }),
      "Edited A",
      "preference-1",
    );
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent normal request");
    expect(screen.queryByRole("button", { name: "Cancel correction" })).toBeNull();
    choose("進め方");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "体験全体から考える");
  });

  it("does not exit a correction reselected during delayed send completion", async () => {
    const pending = pendingVoiceStart();
    native.sendContinuityMessage.mockReturnValueOnce(pending.promise);
    current = {
      ...current,
      understandings: [
        ...current.understandings,
        {
          ...current.understandings[0],
          id: "preference-2",
          title: "Second memory",
          value: "Memory B",
        },
      ],
    };
    render(<ContinuityWorkspace {...props()} language="en" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Normal draft" } });
    const choose = (index: number) => {
      fireEvent.click(screen.getByRole("button", { name: "Memories" }));
      fireEvent.click(screen.getAllByRole("button", { name: "Correct" })[index]);
    };
    choose(0);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Submitted A" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    choose(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Newer B" } });
    choose(0);
    await act(async () => pending.resolve());
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Submitted A");
    expect(screen.getByRole("button", { name: "Cancel correction" })).toBeTruthy();
    choose(1);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Newer B");
    fireEvent.click(screen.getByRole("button", { name: "Cancel correction" }));
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Normal draft");
  });

  it("retains a failed correction for retry and restores the normal draft after success", async () => {
    native.sendContinuityMessage.mockRejectedValueOnce(new Error("Could not save correction"));
    render(<ContinuityWorkspace {...props()} language="en" />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Normal draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Memories" }));
    fireEvent.click(screen.getByRole("button", { name: "Correct" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Edited correction" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Edited correction");
    expect(screen.getByRole("alert").textContent).toContain("Could not save correction");
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    expect(native.sendContinuityMessage).toHaveBeenLastCalledWith(
      expect.anything(),
      "Edited correction",
      "preference-1",
    );
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Normal draft");
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

  it.each([
    ["Memories", "Close memories"],
    ["Settings", "Close settings"],
    ["View question", null],
  ] as const)("keeps focus after navigating to %s while a send is acknowledged", async (destination, focusedButton) => {
    let finish!: () => void;
    native.sendContinuityMessage.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    current = { ...current, messages: [...current.messages, pendingQuestion()] };
    render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    const input = screen.getByRole("textbox");
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.change(input, { target: { value: "First message" } });
    await waitFor(() => expect(send).toHaveProperty("disabled", false));
    send.focus();
    fireEvent.click(send);
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "A newer unsent message" } });
    fireEvent.click(screen.getByRole("button", { name: destination }));
    const target = focusedButton
      ? screen.getByRole("button", { name: focusedButton })
      : screen.getByRole("article", { name: "Reply requested" });
    expect(document.activeElement).toBe(target);
    await act(async () => finish());
    expect(document.activeElement).toBe(target);
    expect(input).toHaveProperty("value", "A newer unsent message");
    expect(native.sendContinuityMessage).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cwd: "/workspace" }),
      "First message",
      undefined,
    );
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it("does not reclaim focus when a hidden workspace is reopened before send acknowledgement", async () => {
    let finish!: () => void;
    native.sendContinuityMessage.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Accepted message" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    view.rerender(<ContinuityWorkspace {...initial} open={false} />);
    view.rerender(<ContinuityWorkspace {...initial} />);
    const reopenedFocus = document.activeElement;
    expect(reopenedFocus).not.toBe(screen.getByRole("textbox"));
    await act(async () => finish());
    expect(document.activeElement).toBe(reopenedFocus);
    expect(screen.getByRole("textbox")).toHaveProperty("value", "");
    expect(native.sendContinuityMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    "another draft",
    "same draft",
    "reopened workspace",
    "hidden workspace",
  ] as const)("keeps the user's %s after an earlier continuation succeeds", async (destination) => {
    let finish!: () => void;
    native.actOnContinuityDraft.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    current = {
      ...current,
      drafts: [
        ...current.drafts,
        {
          id: "draft-2",
          title: "Another draft",
          content: "Other content",
          reason: "",
          status: "ready",
          sourceIds: [],
          createdAt: now,
          updatedAt: now,
        },
      ],
    };
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Open draft" })[0]);
    const originalDialog = screen.getByRole("dialog");
    fireEvent.click(within(originalDialog).getByRole("button", { name: "Continue thinking" }));
    if (destination === "another draft" || destination === "same draft") {
      fireEvent.click(within(originalDialog).getByRole("button", { name: "Close" }));
      fireEvent.click(
        screen.getAllByRole("button", { name: "Open draft" })[
          destination === "another draft" ? 1 : 0
        ],
      );
    } else {
      view.rerender(<ContinuityWorkspace {...initial} open={false} />);
      if (destination === "reopened workspace") view.rerender(<ContinuityWorkspace {...initial} />);
    }
    const currentDialog = screen.queryByRole("dialog");
    if (currentDialog) within(currentDialog).getByRole("button", { name: "Close" }).focus();
    const currentFocus = document.activeElement;
    await act(async () => finish());
    expect(screen.queryByRole("dialog")).toBe(currentDialog);
    expect(document.activeElement).toBe(currentFocus);
    if (currentDialog) expect(currentDialog).toHaveProperty("open", true);
    if (destination === "hidden workspace") {
      view.rerender(<ContinuityWorkspace {...initial} />);
      expect(screen.getByRole("dialog")).toHaveProperty("open", true);
    }
    expect(native.actOnContinuityDraft).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ cwd: "/workspace" }),
      "draft-1",
      "continue",
    );
  });

  it.each([
    ["ja", "送る", "再試行", "入力内容を確認して、送信ボタンからもう一度送ってください。"],
    ["en", "Send", "Retry", "Review your message and use Send to try again."],
  ] as const)("recovers failed %s messages through Send, preserving the actual input", async (language, send, retry, hint) => {
    native.sendContinuityMessage.mockRejectedValueOnce(new Error("モデルに接続できません"));
    const view = render(<ContinuityWorkspace {...props()} language={language} />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: "相談したいこと" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: send }));
    });
    current = { ...current, revision: current.revision + 1, error: null };
    view.rerender(<ContinuityWorkspace {...props()} language={language} />);
    expect(input.value).toBe("相談したいこと");
    expect(screen.getByRole("alert").textContent).toContain("モデルに接続できません");
    expect(screen.getByRole("alert").textContent).toContain(hint);
    expect(screen.queryByRole("button", { name: retry })).toBeNull();
    expect(screen.getByRole("log").textContent).not.toContain("相談したいこと");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: send }));
    });
    expect(native.retryContinuity).not.toHaveBeenCalled();
    expect(native.sendContinuityMessage).toHaveBeenCalledTimes(2);
    expect(native.sendContinuityMessage).toHaveBeenLastCalledWith(
      expect.objectContaining({ personaId: "yori-ja" }),
      "相談したいこと",
      undefined,
    );
    expect(input.value).toBe("");
  });

  it.each([
    "ja",
    "en",
  ] as const)("keeps failed On/Off changes visible without work retry when Pi is unavailable in %s", async (language) => {
    setupNative.invoke.mockResolvedValue({ ...piStatus(), configured: false });
    native.setContinuityAutoEnabled.mockRejectedValueOnce(new Error("Could not save switch"));
    const view = render(
      <ContinuityWorkspace {...props()} language={language} executionBackend="pi" />,
    );
    await waitFor(() =>
      expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true"),
    );
    await act(async () => fireEvent.click(screen.getByRole("switch")));
    current = { ...current, revision: current.revision + 1, error: null };
    view.rerender(<ContinuityWorkspace {...props()} language={language} executionBackend="pi" />);
    expect(screen.getByRole("alert").textContent).toContain("Could not save switch");
    expect(screen.getByRole("alert").textContent).toContain(
      language === "ja" ? "上部のスイッチ" : "switch above",
    );
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(
      screen.queryByRole("button", { name: language === "ja" ? "再試行" : "Retry" }),
    ).toBeNull();
    await act(async () => fireEvent.click(screen.getByRole("switch")));
    expect(native.setContinuityAutoEnabled).toHaveBeenCalledTimes(2);
    expect(native.setContinuityAutoEnabled).toHaveBeenLastCalledWith(expect.anything(), false);
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it.each([
    "send",
    "draft",
    "forget",
    "autonomy",
    "observation",
  ] as const)("retains %s recovery guidance for errors from the shared client", async (errorSource) => {
    native.useContinuity.mockImplementation(() => ({
      snapshot: current,
      error: "Operation failed",
      errorSource,
    }));
    setupNative.invoke.mockResolvedValue({ ...piStatus(), configured: false });
    render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Operation failed"),
    );
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reload status" })).toBeNull();
    if (errorSource === "observation")
      expect(screen.getByRole("alert").textContent).toContain("could not be recorded");
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it.each([
    "rejected",
    "state",
  ] as const)("keeps %s voice failures visible without retrying work while Pi is unavailable", async (failure) => {
    current = { ...current, phase: "error", error: "Pi is not configured" };
    setupNative.invoke.mockResolvedValue({ ...piStatus(), configured: false });
    const onStart = vi.fn().mockRejectedValue(new Error("Microphone unavailable"));
    render(
      <ContinuityWorkspace
        {...props()}
        language="en"
        executionBackend="pi"
        conversation={{
          available: true,
          state:
            failure === "state"
              ? { status: "error", error: "Microphone unavailable" }
              : { status: "idle" },
          onStart,
          onEnd: vi.fn(),
          onSetMuted: vi.fn(),
        }}
      />,
    );
    if (failure === "rejected")
      await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start talking" })));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Microphone unavailable"),
    );
    expect(screen.getByRole("alert").textContent).toContain("microphone button");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it("keeps failed draft recovery on draft controls after the details close", async () => {
    native.actOnContinuityDraft.mockRejectedValueOnce(new Error("Could not save draft action"));
    const view = render(<ContinuityWorkspace {...props()} language="en" />);
    fireEvent.click(screen.getByRole("button", { name: "Open draft" }));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Continue thinking" })),
    );
    expect(screen.getByRole("alert").textContent).toContain("choose the action again");
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    current = { ...current, revision: current.revision + 1, error: null };
    view.rerender(<ContinuityWorkspace {...props()} language="en" />);
    expect(screen.getByRole("alert").textContent).toContain("Could not save draft action");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it("keeps a local voice failure when unrelated native work later succeeds", async () => {
    const initial: ContinuityWorkspaceProps = {
      ...props(),
      language: "en",
      conversation: {
        available: true,
        state: { status: "idle" },
        onStart: vi.fn().mockRejectedValue(new Error("Microphone unavailable")),
        onEnd: vi.fn(),
        onSetMuted: vi.fn(),
      },
    };
    const view = render(<ContinuityWorkspace {...initial} />);
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start talking" })));
    current = { ...current, revision: current.revision + 1, error: null };
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(screen.getByRole("alert").textContent).toContain("Microphone unavailable");
    expect(screen.getByRole("alert").textContent).toContain("microphone button");
  });

  it.each([
    "work",
    "sync",
  ] as const)("replaces failed %s recovery with later shared state without another recovery click", async (source) => {
    let sharedError: string | null = "Initial failure";
    native.useContinuity.mockImplementation(() => ({
      snapshot: current,
      error: sharedError,
      errorSource: sharedError ? source : null,
    }));
    const operation = source === "work" ? native.retryContinuity : native.refreshContinuity;
    operation.mockImplementationOnce(async () => {
      sharedError = "Recovery failed";
      throw new Error(sharedError);
    });
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} />);
    await act(async () =>
      fireEvent.click(
        screen.getByRole("button", { name: source === "work" ? "Retry" : "Reload status" }),
      ),
    );
    expect(screen.getByRole("alert").textContent).toContain("Recovery failed");
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(screen.getByRole("alert").textContent).toContain("Recovery failed");
    sharedError = null;
    current = {
      ...current,
      revision: current.revision + 1,
      phase: "error",
      error: "New native failure",
    };
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(screen.getByRole("alert").textContent).toContain("New native failure");
    expect(screen.getByRole("alert").textContent).not.toContain("Recovery failed");
    current = { ...current, revision: current.revision + 1, phase: "idle", error: null };
    view.rerender(<ContinuityWorkspace {...initial} />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("guards pending work retries and keeps a failed retry available", async () => {
    current = { ...current, phase: "error", error: "Worker unavailable" };
    let sharedError: string | null = null;
    native.useContinuity.mockImplementation(() => ({
      snapshot: current,
      error: sharedError,
      errorSource: sharedError ? "work" : null,
    }));
    let reject!: (reason: Error) => void;
    native.retryContinuity.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
    );
    render(<ContinuityWorkspace {...props()} language="en" />);
    const button = screen.getByRole("button", { name: "Retry" });
    act(() => {
      fireEvent.click(button);
      expect(button).toHaveProperty("disabled", false);
      fireEvent.click(button);
    });
    expect(native.retryContinuity).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Retrying…" })).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      sharedError = "Retry failed";
      reject(new Error(sharedError));
    });
    expect(screen.getByRole("alert").textContent).toContain("Retry failed");
    expect(screen.getByRole("button", { name: "Retry" })).toHaveProperty("disabled", false);
    native.retryContinuity.mockImplementationOnce(async () => {
      sharedError = null;
      current = { ...current, revision: current.revision + 1, phase: "idle", error: null };
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Retry" })));
    expect(native.retryContinuity).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reloads a failed synchronization while Pi is unavailable without explicitly retrying work", async () => {
    current = { ...current, phase: "working" };
    let sharedError: string | null = "Status unavailable";
    native.useContinuity.mockImplementation(() => ({
      snapshot: current,
      error: sharedError,
      errorSource: sharedError ? "sync" : null,
    }));
    setupNative.invoke.mockResolvedValue({ ...piStatus(), configured: false });
    let reject!: (error: Error) => void;
    native.refreshContinuity.mockReturnValueOnce(
      new Promise<void>((_resolve, fail) => {
        reject = fail;
      }),
    );
    render(<ContinuityWorkspace {...props()} language="en" executionBackend="pi" />);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Status unavailable"),
    );
    expect(screen.getByRole("button", { name: "Reload status" })).toHaveProperty("disabled", false);
    act(() => fireEvent.click(screen.getByRole("button", { name: "Reload status" })));
    expect(screen.getByRole("button", { name: "Reloading…" })).toHaveProperty("disabled", true);
    await act(async () => {
      sharedError = "Still unavailable";
      reject(new Error(sharedError));
    });
    expect(screen.getByRole("alert").textContent).toContain("Still unavailable");
    native.refreshContinuity.mockImplementationOnce(async () => {
      sharedError = null;
    });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Reload status" })));
    expect(native.refreshContinuity).toHaveBeenCalledTimes(2);
    expect(native.retryContinuity).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
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

  it.each([
    ["ja", "話しかける", "接続中", "接続をキャンセル"],
    ["en", "Start talking", "Connecting", "Cancel connection"],
  ] as const)("cancels a local pending %s voice start once without touching autonomous work", async (language, start, connecting, cancel) => {
    const pending = pendingVoiceStart();
    const conversation = {
      available: true,
      state: { status: "idle" as const },
      onStart: vi.fn().mockReturnValue(pending.promise),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    };
    current = { ...current, phase: "working" };
    render(<ContinuityWorkspace {...props()} language={language} conversation={conversation} />);
    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "Unsent message" } });
    const startButton = screen.getByRole("button", { name: start });
    act(() => {
      fireEvent.click(startButton);
      fireEvent.click(startButton);
    });
    expect(conversation.onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: connecting })).toHaveProperty("disabled", true);
    const cancelButton = screen.getByRole("button", { name: cancel });
    expect(cancelButton).toHaveProperty("disabled", false);
    fireEvent.click(cancelButton);
    expect(conversation.onEnd).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: start })).toHaveProperty("disabled", false);
    await act(async () => pending.resolve());
    expect(input).toHaveProperty("value", "Unsent message");
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("status").textContent).toBe(language === "ja" ? "作業中" : "Working");
    for (const command of [
      native.sendContinuityMessage,
      native.actOnContinuityDraft,
      native.retryContinuity,
      native.refreshContinuity,
      native.setContinuityAutoEnabled,
      native.forgetContinuityUnderstanding,
    ])
      expect(command).not.toHaveBeenCalled();
  });

  it("cancels a host-owned connecting state and allows another explicit start after it becomes idle", () => {
    const conversation = {
      available: true,
      state: { status: "connecting" as const },
      onStart: vi.fn().mockReturnValue(pendingVoiceStart().promise),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    };
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} conversation={conversation} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection" }));
    expect(conversation.onEnd).toHaveBeenCalledTimes(1);
    expect(conversation.onStart).not.toHaveBeenCalled();
    view.rerender(
      <ContinuityWorkspace
        {...initial}
        conversation={{ ...conversation, state: { status: "idle" } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Start talking" }));
    expect(conversation.onStart).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Cancel connection" })).toBeTruthy();
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it.each([
    "resolve",
    "reject",
  ] as const)("ignores a cancelled startup's late %s while a newer start is pending", async (completion) => {
    const old = pendingVoiceStart();
    const next = pendingVoiceStart();
    const conversation = {
      available: true,
      state: { status: "idle" as const },
      onStart: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    };
    render(<ContinuityWorkspace {...props()} language="en" conversation={conversation} />);
    fireEvent.click(screen.getByRole("button", { name: "Start talking" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Start talking" }));
    await act(async () => {
      if (completion === "resolve") old.resolve();
      else old.reject(new Error("Cancelled failure"));
    });
    expect(screen.getByRole("button", { name: "Connecting" })).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: "Start talking" })).toBeNull();
    expect(screen.queryByText("Cancelled failure")).toBeNull();
    expect(conversation.onStart).toHaveBeenCalledTimes(2);
    await act(async () => next.reject(new Error("Current failure")));
    expect(screen.getByRole("alert").textContent).toContain("Current failure");
    expect(screen.getByRole("button", { name: "Start talking" })).toHaveProperty("disabled", false);
  });

  it("keeps a newer voice failure when a cancelled start rejects later and clears it on explicit cancel", async () => {
    const old = pendingVoiceStart();
    const conversation = {
      available: true,
      state: { status: "idle" as const },
      onStart: vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockRejectedValueOnce(new Error("Current failure")),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    };
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} conversation={conversation} />);
    fireEvent.click(screen.getByRole("button", { name: "Start talking" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection" }));
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Start talking" })));
    await act(async () => old.reject(new Error("Cancelled failure")));
    expect(screen.getByRole("alert").textContent).toContain("Current failure");
    expect(screen.queryByText("Cancelled failure")).toBeNull();
    view.rerender(
      <ContinuityWorkspace
        {...initial}
        conversation={{ ...conversation, state: { status: "connecting" } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection" }));
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("preserves unrelated operation errors when starting and cancelling voice", async () => {
    native.sendContinuityMessage.mockRejectedValueOnce(new Error("Message was not saved"));
    const conversation = {
      available: true,
      state: { status: "idle" as const },
      onStart: vi.fn().mockReturnValue(pendingVoiceStart().promise),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    };
    render(<ContinuityWorkspace {...props()} language="en" conversation={conversation} />);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Unsent message" } });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Send" })));
    fireEvent.click(screen.getByRole("button", { name: "Start talking" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel connection" }));
    expect(screen.getByRole("alert").textContent).toContain("Message was not saved");
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsent message");
    expect(native.sendContinuityMessage).toHaveBeenCalledTimes(1);
    expect(native.retryContinuity).not.toHaveBeenCalled();
  });

  it("ends an active call before startup settles and ignores its failure during a new attempt", async () => {
    const old = pendingVoiceStart();
    const next = pendingVoiceStart();
    const conversation = {
      available: true,
      state: { status: "idle" as const },
      onStart: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    };
    const initial = { ...props(), language: "en" as const };
    const view = render(<ContinuityWorkspace {...initial} conversation={conversation} />);
    fireEvent.click(screen.getByRole("button", { name: "Start talking" }));
    view.rerender(
      <ContinuityWorkspace
        {...initial}
        conversation={{ ...conversation, state: { status: "active" } }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "End voice" }));
    expect(conversation.onEnd).toHaveBeenCalledTimes(1);
    view.rerender(<ContinuityWorkspace {...initial} conversation={conversation} />);
    expect(screen.queryByRole("button", { name: "Cancel connection" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Start talking" }));
    expect(conversation.onStart).toHaveBeenCalledTimes(2);
    await act(async () => old.reject(new Error("Ended call failed late")));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Connecting" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Cancel connection" })).toBeTruthy();
    await act(async () => next.resolve());
    expect(screen.getByRole("button", { name: "Start talking" })).toHaveProperty("disabled", false);
    expect(native.setContinuityAutoEnabled).not.toHaveBeenCalled();
    expect(native.retryContinuity).not.toHaveBeenCalled();
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
