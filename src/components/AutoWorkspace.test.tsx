// @vitest-environment jsdom
import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { openPath } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveAutonomyAction,
  approvePendingWork,
  consultAutonomy,
  declineAutonomyAction,
  declinePendingWork,
  editAutonomyDraft,
  pauseAutonomy,
  runAutonomyNow,
  saveAutonomyContract,
  setAutonomyEnabled,
  undoAutonomyRun,
  useAutonomyDraftSnapshot,
  useAutonomyStatus,
} from "../runtime/autonomy/client";
import type {
  AutonomyContract,
  AutonomyDraftSnapshot,
  AutonomyStatus,
} from "../runtime/autonomy/types";
import { AutoWorkspace, type AutoWorkspaceProps } from "./AutoWorkspace";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openPath: vi.fn(), openUrl: vi.fn() }));
vi.mock("../runtime/autonomy/client", () => ({
  useAutonomyStatus: vi.fn(),
  useAutonomyDraftSnapshot: vi.fn(),
  editAutonomyDraft: vi.fn(),
  approvePendingWork: vi.fn(),
  consultAutonomy: vi.fn(),
  declinePendingWork: vi.fn(),
  pauseAutonomy: vi.fn(),
  runAutonomyNow: vi.fn(),
  saveAutonomyContract: vi.fn(),
  setAutonomyEnabled: vi.fn(),
  undoAutonomyRun: vi.fn(),
  approveAutonomyAction: vi.fn(),
  declineAutonomyAction: vi.fn(),
}));
const contract: AutonomyContract = {
  goal: "メモを整理する",
  root: "/work/notes",
  allowedOperations: ["write"],
  workMode: "documents",
  enabled: true,
  reviewMode: "daily",
  intervalMinutes: 60,
  maxRunsPerDay: 2,
  automaticActionApproval: true,
  publishPullRequest: false,
};
const draftDefaults = {
  id: "proposal",
  goal: "メモを整理する",
  root: "/work/notes",
  allowedOperations: ["write"] as const,
  intervalMinutes: 60,
  maxRunsPerDay: 2,
  reviewMode: "daily" as const,
  workMode: "documents" as const,
  automaticActionApproval: false,
  publishPullRequest: false,
  explanation: "",
};
let snapshot: AutonomyDraftSnapshot;
let backend: AutonomyStatus;
function setDraft(value: AutonomyDraftSnapshot) {
  snapshot = value;
  vi.mocked(useAutonomyDraftSnapshot).mockReturnValue(value);
}
function setStatus(value: Partial<AutonomyStatus> = {}) {
  backend = { contract: null, phase: "idle", nextRunAt: null, runs: [], error: null, ...value };
  vi.mocked(useAutonomyStatus).mockReturnValue(backend);
}
function props(overrides: Partial<AutoWorkspaceProps> = {}): AutoWorkspaceProps {
  return {
    open: true,
    language: "ja",
    cwd: "/work/current",
    onClose: vi.fn(),
    conversation: {
      available: true,
      state: { status: "idle" },
      onStart: vi.fn(async () => {}),
      onEnd: vi.fn(),
      onSetMuted: vi.fn(),
    },
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (value: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  setStatus();
  setDraft({ revision: 0, draft: null });
  vi.mocked(editAutonomyDraft).mockImplementation(async (_baseId, patch) => {
    const next: AutonomyDraftSnapshot = {
      revision: snapshot.revision + 1,
      draft: {
        ...draftDefaults,
        ...snapshot.draft,
        ...patch,
        id: `draft-${snapshot.revision + 1}`,
      },
    };
    setDraft(next);
    return { snapshot: next, conflict: false };
  });
  for (const fn of [
    approvePendingWork,
    declinePendingWork,
    pauseAutonomy,
    runAutonomyNow,
    saveAutonomyContract,
    setAutonomyEnabled,
    undoAutonomyRun,
    approveAutonomyAction,
    declineAutonomyAction,
    openPath,
  ])
    vi.mocked(fn).mockResolvedValue(undefined);
  vi.mocked(choosePath).mockResolvedValue("/work/chosen");
  vi.mocked(consultAutonomy).mockResolvedValue({
    reply: "依頼をまとめました",
    suggestedGoal: "メモを整理する",
    suggestedOperations: ["write"],
  });
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AutoWorkspace", () => {
  it("keeps status and draft subscriptions mounted while closed without starting work or audio", () => {
    const p = props({ open: false });
    render(<AutoWorkspace {...p} />);
    expect(useAutonomyStatus).toHaveBeenCalled();
    expect(useAutonomyDraftSnapshot).toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: "おまかせ" })).toBeNull();
    expect(editAutonomyDraft).not.toHaveBeenCalled();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(p.conversation.onStart).not.toHaveBeenCalled();
  });
  it("offers native voice entry even when Codex needs setup, and does not duplicate the VRM", async () => {
    const defaults = props();
    const p = props({ conversation: { ...defaults.conversation, available: false } });
    render(<AutoWorkspace {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "話しかける" }));
    await waitFor(() => expect(p.conversation.onStart).toHaveBeenCalledOnce());
    expect(document.querySelector("canvas")).toBeNull();
    expect(screen.getByRole("textbox", { name: "よりに伝える" })).toBeTruthy();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
  });
  it("preserves text through call and visibility changes, and routes text through the Main Agent", async () => {
    const send = vi.fn(async () => "了解しました");
    const p = props({ onSendMessage: send });
    const view = render(<AutoWorkspace {...p} />);
    fireEvent.change(screen.getByRole("textbox", { name: "よりに伝える" }), {
      target: { value: "結論を先にして" },
    });
    view.rerender(
      <AutoWorkspace {...p} conversation={{ ...p.conversation, state: { status: "active" } }} />,
    );
    expect(
      (screen.getByRole("textbox", { name: "よりに伝える" }) as HTMLTextAreaElement).value,
    ).toBe("結論を先にして");
    view.rerender(<AutoWorkspace {...p} open={false} />);
    view.rerender(<AutoWorkspace {...p} />);
    expect(
      (screen.getByRole("textbox", { name: "よりに伝える" }) as HTMLTextAreaElement).value,
    ).toBe("結論を先にして");
    fireEvent.click(screen.getByRole("button", { name: "伝える" }));
    await waitFor(() => expect(send).toHaveBeenCalledExactlyOnceWith("結論を先にして"));
    expect(consultAutonomy).not.toHaveBeenCalled();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(await screen.findByText("了解しました")).toBeTruthy();
  });
  it.each([
    "connecting",
    "closed",
  ])("does not start delayed voice after switching to %s", async (destination) => {
    const response = deferred<Awaited<ReturnType<typeof editAutonomyDraft>>>();
    vi.mocked(editAutonomyDraft).mockReturnValueOnce(response.promise);
    const p = props();
    const view = render(<AutoWorkspace {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "話しかける" }));
    await waitFor(() => expect(editAutonomyDraft).toHaveBeenCalledOnce());
    view.rerender(
      <AutoWorkspace
        {...p}
        conversation={{
          ...p.conversation,
          state: { status: destination === "connecting" ? "connecting" : "idle" },
        }}
        open={destination !== "closed"}
      />,
    );
    await act(async () =>
      response.resolve({
        conflict: false,
        snapshot: { revision: 1, draft: { ...draftDefaults, root: "/work/current", id: "synced" } },
      }),
    );
    expect(p.conversation.onStart).not.toHaveBeenCalled();
  });
  it("retains rejected text and reports the real failure without a false response", async () => {
    const send = vi.fn(async () => {
      throw new Error("worker is active");
    });
    render(<AutoWorkspace {...props({ onSendMessage: send })} />);
    fireEvent.change(screen.getByRole("textbox", { name: "よりに伝える" }), {
      target: { value: "この依頼を追加して" },
    });
    fireEvent.click(screen.getByRole("button", { name: "伝える" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "worker is active");
    expect(
      (screen.getByRole("textbox", { name: "よりに伝える" }) as HTMLTextAreaElement).value,
    ).toBe("この依頼を追加して");
    expect(consultAutonomy).not.toHaveBeenCalled();
    expect(screen.queryByRole("log")).toBeNull();
  });
  it("keeps text available through connection, mute and hangup without restarting the call", async () => {
    const send = vi.fn(async () => "");
    const p = props({ onSendMessage: send });
    const view = render(<AutoWorkspace {...p} />);
    const input = screen.getByRole("textbox", { name: "よりに伝える" });
    fireEvent.change(input, { target: { value: "対象は notes/meeting.md です" } });
    for (const state of [
      { status: "connecting" as const },
      { status: "active" as const },
      { status: "active" as const, microphoneMuted: true },
    ]) {
      view.rerender(<AutoWorkspace {...p} conversation={{ ...p.conversation, state }} />);
      expect(screen.getByRole("textbox", { name: "よりに伝える" })).toBe(input);
      expect((input as HTMLTextAreaElement).value).toBe("対象は notes/meeting.md です");
      expect(screen.getByRole("button", { name: "会話を終了" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "話しかける" })).toBeNull();
      expect((screen.getByRole("button", { name: "伝える" }) as HTMLButtonElement).disabled).toBe(
        state.status === "connecting",
      );
    }
    fireEvent.click(screen.getByRole("button", { name: "伝える" }));
    await waitFor(() =>
      expect(send).toHaveBeenCalledExactlyOnceWith("対象は notes/meeting.md です"),
    );
    await waitFor(() => expect((input as HTMLTextAreaElement).value).toBe(""));
    expect(screen.getByRole("log").textContent).toBe("あなた対象は notes/meeting.md です");
    expect(screen.queryByText("返答")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    expect(p.conversation.onEnd).toHaveBeenCalledOnce();
    view.rerender(<AutoWorkspace {...p} />);
    expect(screen.getByRole("textbox", { name: "よりに伝える" })).toBe(input);
    expect(screen.getByRole("button", { name: "話しかける" })).toBeTruthy();
    expect(p.conversation.onStart).not.toHaveBeenCalled();
    expect(pauseAutonomy).not.toHaveBeenCalled();
  });
  it("keeps saved authority untouched and requires explicit normalized delegation of an AI draft", async () => {
    setStatus({ contract, phase: "paused" });
    setDraft({
      revision: 1,
      draft: {
        ...draftDefaults,
        id: "voice-draft",
        goal: "新しい依頼",
        automaticActionApproval: true,
      },
    });
    render(<AutoWorkspace {...props()} />);
    expect(screen.getByText("保存済みの自動許可：送信・公開を含む")).toBeTruthy();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(setAutonomyEnabled).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "依頼を切り替える" }));
    await waitFor(() => expect(saveAutonomyContract).toHaveBeenCalledOnce());
    expect(saveAutonomyContract).toHaveBeenCalledWith(
      {
        goal: "新しい依頼",
        root: "/work/notes",
        allowedOperations: ["write", "move", "trash"],
        intervalMinutes: 30,
        maxRunsPerDay: 4,
        reviewMode: "automatic",
        workMode: "auto",
        automaticActionApproval: false,
        publishPullRequest: false,
        enabled: true,
      },
      "draft-2",
    );
    expect(contract.automaticActionApproval).toBe(true);
    expect(contract.allowedOperations).toEqual(["write"]);
  });
  it("refuses to save a goal that changes while the displayed draft is being flushed", async () => {
    setDraft({ revision: 1, draft: { ...draftDefaults, id: "shown" } });
    const response = deferred<Awaited<ReturnType<typeof editAutonomyDraft>>>();
    vi.mocked(editAutonomyDraft).mockReturnValueOnce(response.promise);
    render(<AutoWorkspace {...props()} />);
    fireEvent.change(screen.getByRole("textbox", { name: "任せたいこと" }), {
      target: { value: "人が入力した依頼" },
    });
    fireEvent.click(screen.getByRole("button", { name: "任せる" }));
    await waitFor(() => expect(editAutonomyDraft).toHaveBeenCalledOnce());
    await act(async () =>
      response.resolve({
        conflict: true,
        snapshot: {
          revision: 2,
          draft: { ...draftDefaults, id: "newer", goal: "会話から届いた別の依頼" },
        },
      }),
    );
    await waitFor(() => expect(screen.getByText(/依頼の更新が重なっています/)).toBeTruthy());
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(
      (screen.getByRole("textbox", { name: "任せたいこと" }) as HTMLTextAreaElement).value,
    ).toBe("人が入力した依頼");
  });
  it("keeps work running when leaving the view or ending voice, while Stop stays available during text work", async () => {
    setStatus({ contract, phase: "thinking" });
    const response = deferred<string>();
    const p = props({ onSendMessage: vi.fn(() => response.promise) });
    const view = render(<AutoWorkspace {...p} />);
    fireEvent.change(screen.getByRole("textbox", { name: "よりに伝える" }), {
      target: { value: "進め方を相談したい" },
    });
    fireEvent.click(screen.getByRole("button", { name: "伝える" }));
    fireEvent.click(screen.getByRole("button", { name: "止める" }));
    await waitFor(() => expect(pauseAutonomy).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect((screen.getByRole("button", { name: "相談中" }) as HTMLButtonElement).disabled).toBe(
        true,
      ),
    );
    vi.mocked(pauseAutonomy).mockClear();
    const live = { ...p.conversation, state: { status: "active" as const } };
    view.rerender(<AutoWorkspace {...p} conversation={live} />);
    fireEvent.click(screen.getByRole("button", { name: "会話を終了" }));
    expect(live.onEnd).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "おまかせを閉じる" }));
    expect(p.onClose).toHaveBeenCalledOnce();
    view.rerender(<AutoWorkspace {...p} open={false} />);
    expect(pauseAutonomy).not.toHaveBeenCalled();
    await act(async () => response.resolve("相談を受け取りました"));
  });

  it("does not commit a new clean voice goal received during preset normalization", async () => {
    setDraft({ revision: 1, draft: { ...draftDefaults, id: "displayed" } });
    const response = deferred<Awaited<ReturnType<typeof editAutonomyDraft>>>();
    vi.mocked(editAutonomyDraft).mockReturnValueOnce(response.promise);
    render(<AutoWorkspace {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "任せる" }));
    await waitFor(() => expect(editAutonomyDraft).toHaveBeenCalledOnce());
    const patch = vi.mocked(editAutonomyDraft).mock.calls[0][1];
    await act(async () =>
      response.resolve({
        conflict: false,
        snapshot: {
          revision: 2,
          draft: {
            ...draftDefaults,
            ...patch,
            id: "changed-in-voice",
            goal: "まだ確認していない目的",
          },
        },
      }),
    );
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "最新の依頼を確認してください",
    );
    expect(saveAutonomyContract).not.toHaveBeenCalled();
  });
  it("distinguishes stopping from stopped and prevents replacing or restarting work during teardown", () => {
    setStatus({ contract: { ...contract, enabled: false }, phase: "stopping" });
    setDraft({ revision: 1, draft: { ...draftDefaults } });
    render(<AutoWorkspace {...props()} />);
    expect((screen.getByRole("button", { name: "停止中" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(
      (screen.getByRole("button", { name: "依頼を切り替える" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.queryByRole("button", { name: "再開" })).toBeNull();
  });
  it("resumes the exact saved scope rather than resaving a draft", async () => {
    setStatus({ contract: { ...contract, enabled: false }, phase: "paused" });
    render(<AutoWorkspace {...props()} />);
    fireEvent.click(screen.getByRole("button", { name: "再開" }));
    await waitFor(() => expect(setAutonomyEnabled).toHaveBeenCalledExactlyOnceWith(true));
    expect(saveAutonomyContract).not.toHaveBeenCalled();
  });
  it("shows the actual live conversation phase", () => {
    const p = props();
    const live = { ...p.conversation, state: { status: "active" as const } };
    const view = render(
      <AutoWorkspace {...p} conversation={{ ...live, phase: "assistant-speaking" }} />,
    );
    expect(screen.getByRole("status").textContent).toBe("話しています");
    view.rerender(
      <AutoWorkspace {...p} conversation={{ ...live, phase: "assistant-responding" }} />,
    );
    expect(screen.getByRole("status").textContent).toBe("考えています");
  });
  it("preserves legacy daily review and exact operation approval instead of treating conversation as approval", async () => {
    setStatus({
      contract,
      phase: "awaitingReview",
      pendingWork: {
        id: "daily-1",
        goal: "今日のメモを整理",
        summary: "関連メモを3件整理",
        reason: "daily",
        changedPaths: [],
      },
    });
    const p = props();
    const view = render(<AutoWorkspace {...p} />);
    fireEvent.click(screen.getByRole("button", { name: "この仕事を任せる" }));
    await waitFor(() => expect(approvePendingWork).toHaveBeenCalledExactlyOnceWith("daily-1"));
    setStatus({
      contract,
      phase: "awaitingAction",
      pendingActions: [
        {
          id: "action-1",
          runId: "run-1",
          kind: "operation",
          payloadDigest: "exact-digest",
          status: "pending",
          createdAt: 1,
          summary: "結果を共有する",
          sourceRoot: "/work/notes",
          operation: "共有する",
          target: "team/report.md",
          impact: "チームが閲覧",
          details: "report.mdの本文",
          changedPaths: ["report.md"],
          checks: [],
        },
      ],
    });
    view.rerender(<AutoWorkspace {...p} />);
    expect(screen.getByText("report.mdの本文")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));
    await waitFor(() =>
      expect(approveAutonomyAction).toHaveBeenCalledExactlyOnceWith("action-1", "exact-digest"),
    );
  });
  it("uses real result evidence and preserves restoration errors", async () => {
    setStatus({
      contract,
      phase: "completed",
      runs: [
        {
          id: "run-1",
          startedAt: 1,
          finishedAt: 2,
          status: "completed",
          summary: "導入を短くしました",
          reason: "",
          changedPaths: ["README.md"],
          validationSummary: "テスト 12件成功",
          developmentPath: "/work/result",
          canUndo: true,
        },
      ],
    });
    vi.mocked(undoAutonomyRun).mockRejectedValueOnce(new Error("変更が競合しています"));
    render(<AutoWorkspace {...props()} />);
    expect(screen.getByText("導入を短くしました")).toBeTruthy();
    expect(screen.getByText("README.md")).toBeTruthy();
    expect(screen.getByText("テスト 12件成功")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "成果物を開く" }));
    await waitFor(() => expect(openPath).toHaveBeenCalledExactlyOnceWith("/work/result"));
    fireEvent.click(screen.getByRole("button", { name: "元に戻す" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "変更が競合しています");
    expect(screen.queryByText("復元済み")).toBeNull();
  });
  it("does not submit text mid-composition and never shows the removed individual settings", async () => {
    const send = vi.fn(async () => "了解");
    render(<AutoWorkspace {...props({ onSendMessage: send })} />);
    const input = screen.getByRole("textbox", { name: "よりに伝える" });
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "整理" } });
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    expect(send).not.toHaveBeenCalled();
    fireEvent.compositionEnd(input);
    fireEvent.click(screen.getByRole("button", { name: "伝える" }));
    await waitFor(() => expect(send).toHaveBeenCalledOnce());
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0);
    expect(screen.queryAllByRole("spinbutton")).toHaveLength(0);
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    expect(screen.queryByRole("button", { name: "話しながら" })).toBeNull();
    expect(screen.queryByRole("button", { name: "静かに" })).toBeNull();
  });
});
