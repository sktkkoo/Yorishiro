// @vitest-environment jsdom

import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approveAutonomyAction,
  approvePendingWork,
  consultAutonomy,
  declineAutonomyAction,
  declinePendingWork,
  editAutonomyDraft,
  pauseAutonomy,
  prepareAutonomyAction,
  runAutonomyNow,
  saveAutonomyContract,
  setAutonomyEnabled,
  undoAutonomyRun,
  useAutonomyDraftSnapshot,
  useAutonomyStatus,
} from "../runtime/autonomy/client";
import type {
  AutonomyAction,
  AutonomyContract,
  AutonomyDraftSnapshot,
  AutonomyStatus,
} from "../runtime/autonomy/types";
import { AutonomyPanel } from "./AutonomyPanel";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../runtime/autonomy/client", () => ({
  useAutonomyStatus: vi.fn(),
  useAutonomyDraftSnapshot: vi.fn(),
  editAutonomyDraft: vi.fn(),
  approvePendingWork: vi.fn(),
  approveAutonomyAction: vi.fn(),
  declinePendingWork: vi.fn(),
  declineAutonomyAction: vi.fn(),
  consultAutonomy: vi.fn(),
  saveAutonomyContract: vi.fn(),
  setAutonomyEnabled: vi.fn(),
  pauseAutonomy: vi.fn(),
  prepareAutonomyAction: vi.fn(),
  runAutonomyNow: vi.fn(),
  undoAutonomyRun: vi.fn(),
}));

const contract: AutonomyContract = {
  workMode: "auto",
  publishPullRequest: false,
  automaticActionApproval: false,
  goal: "読みやすく整理する",
  root: "/Users/test/notes",
  allowedOperations: ["write"],
  intervalMinutes: 30,
  maxRunsPerDay: 4,
  enabled: true,
  reviewMode: "daily",
};

const confirmation: AutonomyAction = {
  id: "action-1",
  runId: "run-1",
  kind: "operation",
  status: "pending",
  createdAt: 1,
  payloadDigest: "reviewed-payload",
  summary: "共有先に影響するため確認が必要です",
  sourceRoot: "/Users/test/notes",
  operation: "報告書を共有フォルダへ配置",
  target: "/Volumes/team/report.md",
  impact: "チームメンバーが閲覧できます",
  details: "report.md を共有フォルダへコピーします。既存ファイルは上書きしません。",
  artifactPath: "/Users/test/notes/report.md",
  changedPaths: ["report.md"],
  checks: [],
};

const draftDefaults = {
  workMode: "auto" as const,
  publishPullRequest: false,
  automaticActionApproval: false,
  id: "empty",
  goal: "",
  root: "",
  allowedOperations: [] as AutonomyContract["allowedOperations"],
  intervalMinutes: 30,
  maxRunsPerDay: 4,
  reviewMode: "daily" as const,
  explanation: "",
};
let sharedDraft: AutonomyDraftSnapshot = { revision: 0, draft: null };
function setDraft(snapshot: AutonomyDraftSnapshot) {
  sharedDraft = snapshot;
  vi.mocked(useAutonomyDraftSnapshot).mockReturnValue(snapshot);
}

function status(overrides: Partial<AutonomyStatus> = {}): AutonomyStatus {
  return { contract: null, phase: "idle", nextRunAt: null, runs: [], error: null, ...overrides };
}

function openPanel() {
  render(<AutonomyPanel />);
  fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
  const settings = screen.getByText("設定", { selector: "summary" });
  if (!settings.closest("details")?.open) fireEvent.click(settings);
}

beforeEach(() => {
  vi.mocked(useAutonomyStatus).mockReturnValue(status());
  sharedDraft = { revision: 0, draft: null };
  setDraft(sharedDraft);
  vi.mocked(editAutonomyDraft).mockImplementation(async (_baseId, patch) => {
    const next = {
      revision: sharedDraft.revision + 1,
      draft: {
        ...draftDefaults,
        ...sharedDraft.draft,
        ...patch,
        id: `edited-${sharedDraft.revision + 1}`,
      },
    };
    setDraft(next);
    return { snapshot: next, conflict: false };
  });
  vi.mocked(openUrl).mockResolvedValue(undefined);
  vi.mocked(choosePath).mockResolvedValue("/Users/test/notes");
  vi.mocked(saveAutonomyContract).mockResolvedValue(undefined);
  vi.mocked(setAutonomyEnabled).mockResolvedValue(undefined);
  vi.mocked(pauseAutonomy).mockResolvedValue(undefined);
  vi.mocked(runAutonomyNow).mockResolvedValue(undefined);
  vi.mocked(undoAutonomyRun).mockResolvedValue(undefined);
  vi.mocked(approvePendingWork).mockResolvedValue(undefined);
  vi.mocked(declinePendingWork).mockResolvedValue(undefined);
  vi.mocked(prepareAutonomyAction).mockResolvedValue(undefined);
  vi.mocked(approveAutonomyAction).mockResolvedValue(undefined);
  vi.mocked(declineAutonomyAction).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AutonomyPanel", () => {
  it.each([
    { enabled: false, phase: "paused" as const, state: "off", description: "自動作業 Off" },
    { enabled: true, phase: "idle" as const, state: "on", description: "自動作業 On" },
    { enabled: true, phase: "thinking" as const, state: "working", description: "実行中" },
  ])("shows $state in the toolbar launcher without starting or toggling work", ({
    enabled,
    phase,
    state,
    description,
  }) => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract: { ...contract, enabled }, phase }),
    );
    render(<AutonomyPanel />);
    const launcher = screen.getByRole("button", { name: "おまかせ作業" });
    expect(launcher.classList.contains("title-bar-button")).toBe(true);
    expect(launcher.dataset.autonomyState).toBe(state);
    expect(launcher.getAttribute("aria-description")).toContain(description);
    expect(launcher.textContent).toContain("AUTO");
    fireEvent.click(launcher);
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(runAutonomyNow).not.toHaveBeenCalled();
    expect(setAutonomyEnabled).not.toHaveBeenCalled();
  });

  it("keeps saved settings collapsed while On/Off and pending approvals stay available", async () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract, phase: "awaitingAction", pendingActions: [confirmation] }),
    );
    render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業 確認待ち 1件" }));
    expect(screen.getByText("設定", { selector: "summary" }).closest("details")?.open).toBe(false);
    expect(screen.getByRole("button", { name: "承認する" })).toBeTruthy();
    expect(screen.getByLabelText("任せる目的").closest("details")?.open).toBe(false);
    const toggle = screen.getByRole("switch", { name: "自動作業" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(setAutonomyEnabled).toHaveBeenCalledExactlyOnceWith(false));
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("opens settings for first setup and incoming conversational changes without collapsing edits", async () => {
    const view = render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    expect(screen.getByText("設定", { selector: "summary" }).closest("details")?.open).toBe(true);
    vi.mocked(useAutonomyStatus).mockReturnValue(status({ contract }));
    view.rerender(<AutonomyPanel />);
    const settings = screen.getByText("設定", { selector: "summary" });
    if (settings.closest("details")?.open) fireEvent.click(settings);
    setDraft({
      revision: 1,
      draft: {
        ...draftDefaults,
        ...contract,
        id: "voice-change",
        reviewMode: "daily",
        explanation: "",
      },
    });
    view.rerender(<AutonomyPanel />);
    await waitFor(() => expect(settings.closest("details")?.open).toBe(true));
    fireEvent.change(screen.getByRole("textbox", { name: "任せる目的" }), {
      target: { value: "編集中" },
    });
    view.rerender(<AutonomyPanel />);
    expect(settings.closest("details")?.open).toBe(true);
  });

  it("shows three concise run summaries and preserves older records behind Show all", () => {
    const longSummary = "長い作業報告です。".repeat(30);
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        runs: Array.from({ length: 5 }, (_, index) => ({
          id: `run-${index}`,
          startedAt: index + 1,
          finishedAt: index + 2,
          status: "completed" as const,
          summary: index === 4 ? longSummary : `作業 ${index}`,
          reason: "理由",
          changedPaths: [],
          canUndo: false,
        })),
      }),
    );
    render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
    const first = screen.getAllByRole("article")[0];
    expect(first.querySelector("p")?.textContent?.length).toBeLessThan(170);
    expect(first.querySelector("details")?.open).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "すべて表示（5件）" }));
    expect(screen.getAllByRole("article")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "最新3件を表示" }));
    expect(screen.getAllByRole("article")).toHaveLength(3);
  });

  it("makes post-work confirmation visible and prevents another run while awaiting approval", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract, phase: "awaitingAction", pendingActions: [confirmation] }),
    );
    render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業 確認待ち 1件" }));
    expect(screen.getByRole("region", { name: "承認待ち" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "今すぐ進める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "承認する" })).toBeTruthy();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
    expect(approvePendingWork).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("shows a ready confirmation without a preparation step (%s)", (hasArtifact) => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        phase: "awaitingAction",
        runs: [
          {
            id: "run-1",
            startedAt: 1,
            finishedAt: 2,
            status: "completed",
            summary: "報告書を保存しました",
            reason: "依頼に沿った文書作成",
            changedPaths: ["report.md"],
            canUndo: false,
            developmentPath: hasArtifact ? "/old/review-artifact" : undefined,
          },
        ],
        pendingActions: [confirmation],
      }),
    );
    render(<AutonomyPanel />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業 確認待ち 1件" }));
    expect(screen.getByRole("button", { name: "承認する" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "見送る" })).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole("region", { name: "承認待ち" }));
    expect(screen.queryByRole("button", { name: "次の操作を確認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "確認事項を作成" })).toBeNull();
    expect(prepareAutonomyAction).not.toHaveBeenCalled();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
    expect(runAutonomyNow).not.toHaveBeenCalled();
  });

  it("keeps plain result history free of an intermediate confirmation creation control", () => {
    const completedRun = {
      id: "completed",
      startedAt: 1,
      finishedAt: 2,
      status: "completed" as const,
      summary: "報告書を保存しました",
      reason: "依頼に沿った文書作成",
      changedPaths: ["report.md"],
      canUndo: false,
    };
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        runs: [
          completedRun,
          { ...completedRun, id: "failed", status: "failed" },
          { ...completedRun, id: "cancelled", status: "cancelled" },
        ],
      }),
    );
    openPanel();
    expect(screen.queryByRole("button", { name: "次の操作を確認" })).toBeNull();
    expect(screen.queryByRole("button", { name: "確認事項を作成" })).toBeNull();
    expect(screen.queryByRole("region", { name: "承認待ち" })).toBeNull();
    expect(screen.getByRole("button", { name: "結果についてAIに相談" })).toBeTruthy();
    expect(prepareAutonomyAction).not.toHaveBeenCalled();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("does not steal focus when a confirmation arrives while the user is editing", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(status({ contract }));
    const view = render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    fireEvent.click(screen.getByText("設定", { selector: "summary" }));
    const goal = screen.getByRole("textbox", { name: "任せる目的" });
    goal.focus();
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract, phase: "awaitingAction", pendingActions: [confirmation] }),
    );
    view.rerender(<AutonomyPanel />);
    expect(screen.getByRole("button", { name: "承認する" })).toBeTruthy();
    expect(document.activeElement).toBe(goal);
    expect(prepareAutonomyAction).not.toHaveBeenCalled();
  });

  it("shows queued execution without counting an approved operation as pending", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        phase: "awaitingAction",
        pendingActions: [{ ...confirmation, status: "approved" }],
      }),
    );
    openPanel();
    expect(screen.getByRole("region", { name: "承認履歴" })).toBeTruthy();
    const history = screen.getByText("承認履歴", { selector: "summary" });
    expect(history.closest("details")?.open).toBe(false);
    fireEvent.click(history);
    expect(screen.queryByRole("region", { name: "承認待ち" })).toBeNull();
    expect(screen.getByText("承認済み・実行待ち")).toBeTruthy();
    expect(screen.getByText("承認した操作の実行を準備しています")).toBeTruthy();
    expect(screen.queryByText("確認待ち 1件")).toBeNull();
    expect(
      (screen.getByRole("button", { name: "今すぐ進める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "承認を取り消す" })).toBeTruthy();
    expect(runAutonomyNow).not.toHaveBeenCalled();
  });

  it("shows approved-operation execution and prevents overlapping work", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        phase: "executingAction",
        pendingActions: [{ ...confirmation, status: "executing" }],
      }),
    );
    openPanel();
    expect(screen.getByText("承認した操作を実行しています")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "今すぐ進める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "一時停止" })).toBeTruthy();
    fireEvent.click(screen.getByText("承認履歴", { selector: "summary" }));
    expect(screen.getByText("実行中")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "承認を取り消す" })).toBeNull();
  });

  it.each([
    "completed",
    "failed",
    "interrupted",
  ] as const)("does not block the next work after a %s operation", (actionStatus) => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        phase: "idle",
        nextRunAt: 1_800_000,
        pendingActions: [{ ...confirmation, status: actionStatus }],
      }),
    );
    openPanel();
    expect(
      (screen.getByRole("button", { name: "今すぐ進める" }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(screen.getByText(/^次回:/)).toBeTruthy();
    expect(screen.queryByRole("region", { name: "承認待ち" })).toBeNull();
    expect(runAutonomyNow).not.toHaveBeenCalled();
  });

  it("keeps stop visibly pending and prevents another run until teardown finishes", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract: { ...contract, enabled: false }, phase: "stopping" }),
    );
    openPanel();
    expect(screen.getByText("作業プロセスの終了を待っています")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "今すぐ進める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getByRole("button", { name: "一時停止" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    expect(screen.queryByText("一時停止中")).toBeNull();
  });

  it("keeps old saved scopes unchanged while showing one objective and scope flow", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract: {
          ...contract,
          goal: "機能を実装してPRを作る",
          workMode: undefined,
          publishPullRequest: undefined,
        },
      }),
    );
    openPanel();
    expect(screen.queryByLabelText("文書の整理・編集")).toBeNull();
    expect(screen.queryByLabelText("開発・改善")).toBeNull();
    expect(screen.queryByLabelText("このリポジトリにドラフトPRを作成する")).toBeNull();
    expect(
      (screen.getByLabelText("目的達成に必要な操作を自動で許可する") as HTMLInputElement).checked,
    ).toBe(false);
    expect((screen.getByLabelText("作成・編集") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("移動") as HTMLInputElement).checked).toBe(false);
    const save = screen.getByRole("button", { name: "この範囲で任せる" });
    const hintId = save.getAttribute("aria-describedby");
    expect(hintId && document.getElementById(hintId)?.textContent).toContain(
      "設定を保存して自動作業を有効にします",
    );
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(editAutonomyDraft).not.toHaveBeenCalled();
  });

  it("keeps automatic publication disabled unless the user explicitly allows it", async () => {
    setDraft({
      revision: 1,
      draft: { ...draftDefaults, goal: "ユーザー体験を改善する", root: "/repo" },
    });
    openPanel();
    const save = screen.getByRole("button", { name: "この範囲で任せる" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(screen.getByText(/コミット済みの内容を別の作業場所/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText("作成・編集"));
    fireEvent.click(screen.getByLabelText("移動"));
    fireEvent.click(screen.getByLabelText("退避"));
    await waitFor(() => expect(save.disabled).toBe(false));
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(runAutonomyNow).not.toHaveBeenCalled();
    fireEvent.click(save);
    await waitFor(() =>
      expect(saveAutonomyContract).toHaveBeenCalledExactlyOnceWith(
        {
          goal: "ユーザー体験を改善する",
          root: "/repo",
          allowedOperations: ["write", "move", "trash"],
          intervalMinutes: 30,
          maxRunsPerDay: 4,
          reviewMode: "daily",
          enabled: true,
          workMode: "auto",
          publishPullRequest: false,
          automaticActionApproval: false,
        },
        sharedDraft.draft?.id,
      ),
    );
  });

  it("keeps saved automatic action permission visible and preserves it on explicit save", async () => {
    const legacy = { ...contract, workMode: "development" as const, automaticActionApproval: true };
    vi.mocked(useAutonomyStatus).mockReturnValue(status({ contract: legacy }));
    openPanel();
    expect(screen.queryByLabelText("このリポジトリにドラフトPRを作成する")).toBeNull();
    expect(
      (screen.getByLabelText("目的達成に必要な操作を自動で許可する") as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      screen.getByText(
        "外部送信などツールを使う操作には、作成・編集／移動／退避の許可が必要です。",
      ),
    ).toBeTruthy();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(editAutonomyDraft).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "この範囲で任せる" }));
    await waitFor(() =>
      expect(saveAutonomyContract).toHaveBeenCalledExactlyOnceWith(
        {
          ...legacy,
          workMode: "auto",
          automaticActionApproval: true,
        },
        null,
      ),
    );
  });

  it("keeps legacy publication grants separate from generic automatic action permission", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract: { ...contract, publishPullRequest: true } }),
    );
    openPanel();
    expect(
      (screen.getByLabelText("目的達成に必要な操作を自動で許可する") as HTMLInputElement).checked,
    ).toBe(false);
    expect(saveAutonomyContract).not.toHaveBeenCalled();
  });

  it.each([
    true,
    false,
  ])("saves explicit automatic action permission of %s after synchronizing the shared draft", async (allowed) => {
    setDraft({
      revision: 1,
      draft: {
        ...draftDefaults,
        goal: "報告を整理して共有する",
        root: "/notes",
        allowedOperations: ["write", "move", "trash"],
        automaticActionApproval: !allowed,
      },
    });
    openPanel();
    const permission = screen.getByLabelText(
      "目的達成に必要な操作を自動で許可する",
    ) as HTMLInputElement;
    expect(permission.checked).toBe(!allowed);
    fireEvent.click(permission);
    await waitFor(() =>
      expect(editAutonomyDraft).toHaveBeenCalledExactlyOnceWith("empty", {
        automaticActionApproval: allowed,
      }),
    );
    expect(permission.checked).toBe(allowed);
    expect(screen.queryByText(/外部送信などツールを使う操作には/)).toBeNull();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    const save = screen.getByRole("button", { name: "この範囲で任せる" }) as HTMLButtonElement;
    await waitFor(() => expect(save.disabled).toBe(false));
    fireEvent.click(save);
    await waitFor(() =>
      expect(saveAutonomyContract).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ root: "/notes", automaticActionApproval: allowed }),
        sharedDraft.draft?.id,
      ),
    );
  });

  it("retains local evidence without exposing a PR-specific operation", () => {
    const baseRun = {
      id: "development-1",
      startedAt: 1,
      finishedAt: 2,
      status: "completed" as const,
      summary: "設定画面を改善しました",
      reason: "操作の迷いを減らすため",
      changedPaths: [],
      canUndo: false,
      developmentPath: "/work/run-1/repository",
      branch: "autonomy/run-1",
      validationSummary: "12 tests passed",
    };
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        runs: [
          { ...baseRun, pullRequestUrl: "https://github.com/example/project/pull/12" },
          {
            ...baseRun,
            id: "malformed",
            pullRequestUrl: "https://github.com.evil.test/example/project/pull/12",
          },
          { ...baseRun, id: "local", pullRequestUrl: "file:///etc/passwd" },
        ],
      }),
    );
    openPanel();
    expect(screen.getAllByText("確認用の成果物: /work/run-1/repository")).toHaveLength(3);
    expect(screen.getAllByText("検証: 12 tests passed")).toHaveLength(3);
    expect(screen.queryByRole("button", { name: "ドラフトPRを開く" })).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it("turns AI suggestions into an editable draft and grants scope only after explicit save", async () => {
    vi.mocked(consultAutonomy).mockImplementation(async () => {
      setDraft({
        revision: 1,
        draft: {
          ...draftDefaults,
          ...contract,
          id: "voice-1",
          allowedOperations: ["write", "trash"],
          reviewMode: "daily",
        },
      });
      return {
        reply: "文章の整理を任せてもらうのがよさそうです。",
        suggestedGoal: contract.goal,
        suggestedOperations: ["write", "trash"],
        suggestedRoot: contract.root,
        suggestedIntervalMinutes: 30,
        suggestedMaxRunsPerDay: 4,
        suggestedReviewMode: "daily",
      };
    });
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "文字で相談する" }));
    fireEvent.change(screen.getByLabelText("相談したいこと"), {
      target: { value: "メモを整理してほしい" },
    });
    fireEvent.click(screen.getByRole("button", { name: "AIと相談する" }));
    await waitFor(() =>
      expect((screen.getByLabelText("任せる目的") as HTMLTextAreaElement).value).toBe(
        contract.goal,
      ),
    );
    expect(consultAutonomy).toHaveBeenCalledExactlyOnceWith([
      { role: "user", content: "メモを整理してほしい" },
    ]);
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(runAutonomyNow).not.toHaveBeenCalled();

    fireEvent.click(screen.getByLabelText("退避"));
    expect((screen.getByLabelText("対象フォルダ") as HTMLInputElement).value).toBe(contract.root);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "この範囲で任せる" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "この範囲で任せる" }));
    await waitFor(() =>
      expect(saveAutonomyContract).toHaveBeenCalledExactlyOnceWith(contract, sharedDraft.draft?.id),
    );
  });

  it("keeps setup failure visible without saving or starting work", async () => {
    vi.mocked(consultAutonomy).mockRejectedValue(new Error("Claude Codeにログインしてください"));
    openPanel();
    fireEvent.click(screen.getByRole("button", { name: "文字で相談する" }));
    fireEvent.change(screen.getByLabelText("相談したいこと"), { target: { value: "相談したい" } });
    fireEvent.click(screen.getByRole("button", { name: "AIと相談する" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Claude Codeにログインしてください",
    );
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(runAutonomyNow).not.toHaveBeenCalled();
  });

  it("can start a text conversation with no typed message or manual settings", async () => {
    vi.mocked(consultAutonomy).mockResolvedValue({
      reply: "どんな仕事を任せたいですか？",
      suggestedGoal: "",
      suggestedRoot: "",
      suggestedOperations: [],
      suggestedIntervalMinutes: 30,
      suggestedMaxRunsPerDay: 4,
      suggestedReviewMode: "daily",
    });
    openPanel();
    expect((screen.getByLabelText("任せる目的") as HTMLTextAreaElement).value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "文字で相談する" }));
    fireEvent.click(screen.getByRole("button", { name: "AIと相談する" }));
    await waitFor(() =>
      expect(consultAutonomy).toHaveBeenCalledExactlyOnceWith([
        {
          role: "user",
          content: "おまかせ作業の目的と範囲を相談したいです。質問から始めてください。",
        },
      ]),
    );
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(choosePath).not.toHaveBeenCalled();
  });

  it("starts real voice setup through the host and surfaces unavailable voice without granting scope", async () => {
    let requestId = "";
    const listener = (event: Event) => {
      requestId = (event as CustomEvent<{ requestId: string }>).detail.requestId;
    };
    window.addEventListener("yorishiro:autonomy-voice-setup-requested", listener);
    try {
      openPanel();
      fireEvent.click(screen.getByRole("button", { name: "音声で相談する" }));
      await waitFor(() => expect(requestId).not.toBe(""));
      fireEvent(
        window,
        new CustomEvent("yorishiro:autonomy-voice-setup-status", {
          detail: { requestId: "stale", phase: "error", message: "古い失敗" },
        }),
      );
      expect(screen.queryByText("古い失敗")).toBeNull();
      fireEvent(
        window,
        new CustomEvent("yorishiro:autonomy-voice-setup-status", {
          detail: { requestId, phase: "error", message: "この会話では音声を開始できません。" },
        }),
      );
      expect((await screen.findByRole("alert")).textContent).toContain("音声を開始できません");
      expect(saveAutonomyContract).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("yorishiro:autonomy-voice-setup-requested", listener);
    }
  });

  it("applies a conversation draft once and keeps manual adjustments across repeated polls", async () => {
    const draft = {
      id: "draft-1",
      goal: contract.goal,
      root: contract.root,
      allowedOperations: contract.allowedOperations,
      intervalMinutes: 60,
      maxRunsPerDay: 2,
      reviewMode: "daily" as const,
      explanation: "話した内容をまとめました。",
    };
    const view = render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    setDraft({ revision: 1, draft });
    view.rerender(<AutonomyPanel />);
    await screen.findByText(draft.explanation);
    expect((screen.getByLabelText("確認する間隔（分）") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("対象フォルダ") as HTMLInputElement).value).toBe(contract.root);
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("任せる目的"), {
      target: { value: "手で調整した目的" },
    });
    setDraft({ revision: 1, draft: { ...draft } });
    view.rerender(<AutonomyPanel />);
    expect((screen.getByLabelText("任せる目的") as HTMLTextAreaElement).value).toBe(
      "手で調整した目的",
    );
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "この範囲で任せる" }) as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "この範囲で任せる" }));
    await waitFor(() =>
      expect(saveAutonomyContract).toHaveBeenCalledExactlyOnceWith(
        {
          ...contract,
          goal: "手で調整した目的",
          intervalMinutes: 60,
          maxRunsPerDay: 2,
        },
        sharedDraft.draft?.id,
      ),
    );
  });

  it("keeps pending input across close and reopen and shares it without enabling work", async () => {
    openPanel();
    fireEvent.change(screen.getByLabelText("任せる目的"), {
      target: { value: "まだ入力中の目的" },
    });
    fireEvent.change(screen.getByLabelText("対象フォルダ"), { target: { value: "/my-notes" } });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    expect((screen.getByLabelText("任せる目的") as HTMLTextAreaElement).value).toBe(
      "まだ入力中の目的",
    );
    await waitFor(() =>
      expect(editAutonomyDraft).toHaveBeenCalledWith(
        null,
        expect.objectContaining({
          goal: "まだ入力中の目的",
          root: "/my-notes",
        }),
      ),
    );
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(runAutonomyNow).not.toHaveBeenCalled();
  });

  it("updates clean fields immediately while keeping a conflicting human field for review", async () => {
    setDraft({
      revision: 1,
      draft: { ...draftDefaults, ...contract, id: "first", reviewMode: "daily" },
    });
    const view = render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    fireEvent.change(screen.getByLabelText("任せる目的"), {
      target: { value: "自分が書いた目的" },
    });
    setDraft({
      revision: 2,
      draft: {
        ...draftDefaults,
        ...contract,
        id: "second",
        goal: "AIが書いた目的",
        root: "/new-folder",
        reviewMode: "daily",
      },
    });
    view.rerender(<AutonomyPanel />);
    expect((screen.getByLabelText("任せる目的") as HTMLTextAreaElement).value).toBe(
      "自分が書いた目的",
    );
    expect((screen.getByLabelText("対象フォルダ") as HTMLInputElement).value).toBe("/new-folder");
    expect(
      (screen.getByRole("button", { name: "この範囲で任せる" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    expect(screen.getByRole("group", { name: "目的の更新を確認" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "自分の入力を残す" }));
    await waitFor(() =>
      expect(editAutonomyDraft).toHaveBeenCalledExactlyOnceWith("second", {
        goal: "自分が書いた目的",
      }),
    );
    expect(saveAutonomyContract).not.toHaveBeenCalled();
  });

  it("publishes typing before immediately starting the next text consultation", async () => {
    vi.mocked(consultAutonomy).mockImplementation(async () => {
      expect(sharedDraft.draft?.goal).toBe("今入力した目的");
      return { reply: "この目的で相談しましょう", suggestedGoal: "", suggestedOperations: [] };
    });
    openPanel();
    fireEvent.change(screen.getByLabelText("任せる目的"), { target: { value: "今入力した目的" } });
    fireEvent.click(screen.getByRole("button", { name: "文字で相談する" }));
    fireEvent.click(screen.getByRole("button", { name: "AIと相談する" }));
    await waitFor(() => expect(consultAutonomy).toHaveBeenCalledOnce());
    expect(saveAutonomyContract).not.toHaveBeenCalled();
  });

  it("offers immediate pause while a worker is running and prevents duplicate manual starts", async () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(status({ contract, phase: "thinking" }));
    openPanel();
    expect(
      (screen.getByRole("button", { name: "今すぐ進める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "一時停止" }));
    await waitFor(() => expect(pauseAutonomy).toHaveBeenCalledOnce());
  });

  it.each([
    "approve",
    "decline",
  ] as const)("%s handles today's proposed job without changing standing scope", async (action) => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        phase: "awaitingReview",
        pendingWork: {
          id: "today-1",
          goal: "会議メモを整理する",
          reason: "次回会議の準備のため",
          summary: "決定事項と未解決事項をまとめたいです。",
          changedPaths: ["会議.md"],
        },
      }),
    );
    openPanel();
    expect(screen.getByRole("button", { name: "おまかせ作業" }).getAttribute("title")).toContain(
      "今日の仕事を相談",
    );
    expect(screen.getByText("会議メモを整理する")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "今すぐ進める" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(approvePendingWork).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", {
        name: action === "approve" ? "この仕事を任せる" : "今回は見送る",
      }),
    );
    await waitFor(() =>
      expect(
        action === "approve" ? approvePendingWork : declinePendingWork,
      ).toHaveBeenCalledExactlyOnceWith("today-1"),
    );
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(runAutonomyNow).not.toHaveBeenCalled();
  });

  it("allows a single manual run while the schedule is paused, and can stop that run", async () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract: { ...contract, enabled: false }, phase: "paused" }),
    );
    const view = render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    fireEvent.click(screen.getByRole("button", { name: "今すぐ進める" }));
    await waitFor(() => expect(runAutonomyNow).toHaveBeenCalledOnce());
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract: { ...contract, enabled: false }, phase: "thinking" }),
    );
    view.rerender(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "一時停止" }));
    await waitFor(() => expect(pauseAutonomy).toHaveBeenCalledOnce());
    expect(saveAutonomyContract).not.toHaveBeenCalled();
  });

  it("shows real completed changes and preserves restore conflict errors", async () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        phase: "completed",
        runs: [
          {
            id: "run-1",
            startedAt: 100,
            finishedAt: 200,
            status: "completed",
            summary: "メモを整理しました",
            reason: "読み返しやすくするため",
            changedPaths: ["notes.md"],
            canUndo: true,
          },
        ],
      }),
    );
    vi.mocked(undoAutonomyRun).mockRejectedValue(new Error("その後の編集があるため元に戻せません"));
    openPanel();
    expect(screen.getByText("notes.md")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "この作業を元に戻す" }));
    await waitFor(() => expect(undoAutonomyRun).toHaveBeenCalledExactlyOnceWith("run-1"));
    expect((await screen.findByRole("alert")).textContent).toContain("その後の編集");
    expect(screen.queryByText("変更を元に戻しました。")).toBeNull();
  });

  it("keeps shared fields visible and gives the icon-only close button an accessible name", async () => {
    openPanel();
    expect(screen.getByRole("heading", { name: "AIに相談" })).toBeTruthy();
    expect(screen.getByText("作業の目的・範囲・実行状況を管理")).toBeTruthy();
    const close = screen.getByRole("button", { name: "おまかせ作業を閉じる" });
    expect(close.textContent).toBe("");
    expect(close.querySelector("svg")).toBeTruthy();
    for (const label of [
      "任せる目的",
      "対象フォルダ",
      "作成・編集",
      "その日の仕事を先に相談",
      "確認する間隔（分）",
      "24時間の実行上限（回）",
    ]) {
      expect(screen.getByLabelText(label).closest("details")?.open).toBe(true);
    }
    const help = screen.getByText("作業の範囲と実行条件").closest("details");
    expect(help?.open).toBe(false);
    fireEvent.click(close);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    expect(pauseAutonomy).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "おまかせ作業" })),
    );
  });

  it("shows newest work first without mutating history and omits empty failure details", () => {
    const runs: AutonomyStatus["runs"] = [
      {
        id: "old",
        startedAt: 1,
        finishedAt: 2,
        status: "completed",
        summary: "以前の成果",
        reason: "",
        changedPaths: ["old.md"],
        canUndo: false,
      },
      {
        id: "failed",
        startedAt: 3,
        finishedAt: 4,
        status: "failed",
        summary: "起動できませんでした",
        reason: "認証が必要です",
        changedPaths: [],
        canUndo: false,
      },
      {
        id: "new",
        startedAt: 5,
        finishedAt: 6,
        status: "completed",
        summary: "最新の成果",
        reason: "",
        changedPaths: ["new.md"],
        canUndo: false,
      },
    ];
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({ contract, runs, phase: "failed", error: "ログインしてから再開してください" }),
    );
    openPanel();
    const articles = screen.getAllByRole("article");
    expect(articles.map((article) => article.querySelector("p")?.textContent)).toEqual([
      "最新の成果",
      "起動できませんでした",
      "以前の成果",
    ]);
    expect(articles[0].querySelector("details")?.open).toBe(false);
    expect(articles[1].querySelector("details")?.open).toBe(false);
    expect(articles[2].querySelector("details")?.open).toBe(false);
    expect(runs.map((run) => run.id)).toEqual(["old", "failed", "new"]);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("ログインしてから再開してください");
    expect(
      alert.compareDocumentPosition(screen.getByRole("region", { name: "作業状況" })) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(screen.getAllByText("ログインしてから再開してください")).toHaveLength(1);
  });

  it.each([false, true])("skips controls hidden by any collapsed ancestor (%s)", (withDecision) => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        pendingActions: withDecision ? [{ ...confirmation, status: "declined" }] : [],
      }),
    );
    render(<AutonomyPanel />);
    fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
    const outer = screen.getByText(withDecision ? "承認履歴" : "設定", { selector: "summary" });
    expect(outer.closest("details")?.open).toBe(false);
    const close = screen.getByRole("button", { name: "おまかせ作業を閉じる" });
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(outer);
    fireEvent.keyDown(outer, { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("wraps keyboard focus around visible controls and skips collapsed run actions", () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(
      status({
        contract,
        runs: [
          {
            id: "latest",
            startedAt: 2,
            finishedAt: 3,
            status: "completed",
            summary: "最新の仕事",
            reason: "",
            changedPaths: ["latest.md"],
            canUndo: false,
          },
          {
            id: "older",
            startedAt: 1,
            finishedAt: 2,
            status: "completed",
            summary: "前の仕事",
            reason: "",
            changedPaths: ["older.md"],
            canUndo: false,
          },
        ],
      }),
    );
    openPanel();
    const close = screen.getByRole("button", { name: "おまかせ作業を閉じる" });
    const summaries = screen.getAllByText("詳細", { selector: "summary" });
    expect(summaries[0].closest("details")?.open).toBe(false);
    expect(summaries[1].closest("details")?.open).toBe(false);
    close.focus();
    fireEvent.keyDown(close, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(summaries[1]);
    fireEvent.keyDown(summaries[1], { key: "Tab" });
    expect(document.activeElement).toBe(close);
  });

  it("closes with Escape and restores focus without pausing scheduled work", async () => {
    vi.mocked(useAutonomyStatus).mockReturnValue(status({ contract }));
    openPanel();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "おまかせ作業" })),
    );
    expect(pauseAutonomy).not.toHaveBeenCalled();
  });
});
