// @vitest-environment jsdom

import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvePendingWork,
  consultAutonomy,
  declinePendingWork,
  pauseAutonomy,
  runAutonomyNow,
  saveAutonomyContract,
  undoAutonomyRun,
  useAutonomyDraft,
  useAutonomyStatus,
} from "../runtime/autonomy/client";
import type { AutonomyContract, AutonomyStatus } from "../runtime/autonomy/types";
import { AutonomyPanel } from "./AutonomyPanel";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../runtime/autonomy/client", () => ({
  useAutonomyStatus: vi.fn(),
  useAutonomyDraft: vi.fn(),
  approvePendingWork: vi.fn(),
  declinePendingWork: vi.fn(),
  consultAutonomy: vi.fn(),
  saveAutonomyContract: vi.fn(),
  pauseAutonomy: vi.fn(),
  runAutonomyNow: vi.fn(),
  undoAutonomyRun: vi.fn(),
}));

const contract: AutonomyContract = {
  goal: "読みやすく整理する",
  root: "/Users/test/notes",
  allowedOperations: ["write"],
  intervalMinutes: 30,
  maxRunsPerDay: 4,
  enabled: true,
  reviewMode: "daily",
};

function status(overrides: Partial<AutonomyStatus> = {}): AutonomyStatus {
  return { contract: null, phase: "idle", nextRunAt: null, runs: [], error: null, ...overrides };
}

function openPanel() {
  render(<AutonomyPanel />);
  fireEvent.click(screen.getByRole("button", { name: "おまかせ作業" }));
}

beforeEach(() => {
  vi.mocked(useAutonomyStatus).mockReturnValue(status());
  vi.mocked(useAutonomyDraft).mockReturnValue(null);
  vi.mocked(choosePath).mockResolvedValue("/Users/test/notes");
  vi.mocked(saveAutonomyContract).mockResolvedValue(undefined);
  vi.mocked(pauseAutonomy).mockResolvedValue(undefined);
  vi.mocked(runAutonomyNow).mockResolvedValue(undefined);
  vi.mocked(undoAutonomyRun).mockResolvedValue(undefined);
  vi.mocked(approvePendingWork).mockResolvedValue(undefined);
  vi.mocked(declinePendingWork).mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("AutonomyPanel", () => {
  it("turns AI suggestions into an editable draft and grants scope only after explicit save", async () => {
    vi.mocked(consultAutonomy).mockResolvedValue({
      reply: "文章の整理を任せてもらうのがよさそうです。",
      suggestedGoal: contract.goal,
      suggestedOperations: ["write", "trash"],
      suggestedRoot: contract.root,
      suggestedIntervalMinutes: 30,
      suggestedMaxRunsPerDay: 4,
      suggestedReviewMode: "daily",
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

    fireEvent.click(screen.getByText("設定案を調整"));
    fireEvent.click(screen.getByLabelText("ファイルの退避"));
    await screen.findByText(contract.root);
    fireEvent.click(screen.getByRole("button", { name: "この範囲で任せる" }));
    await waitFor(() => expect(saveAutonomyContract).toHaveBeenCalledExactlyOnceWith(contract));
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
    expect(screen.queryByLabelText("任せる目的")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "文字で相談する" }));
    fireEvent.click(screen.getByRole("button", { name: "AIと相談する" }));
    await waitFor(() =>
      expect(consultAutonomy).toHaveBeenCalledExactlyOnceWith([
        {
          role: "user",
          content: "おまかせ作業の目的と範囲を一緒に決めたいです。質問から始めてください。",
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
      expect(requestId).not.toBe("");
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
    vi.mocked(useAutonomyDraft).mockReturnValue(draft);
    view.rerender(<AutonomyPanel />);
    await screen.findByText(draft.explanation);
    expect(screen.getByText("60分ごと・24時間に最大2回")).toBeTruthy();
    expect(screen.getByText(contract.root)).toBeTruthy();
    expect(saveAutonomyContract).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText("設定案を調整"));
    fireEvent.change(screen.getByLabelText("任せる目的"), {
      target: { value: "手で調整した目的" },
    });
    vi.mocked(useAutonomyDraft).mockReturnValue({ ...draft });
    view.rerender(<AutonomyPanel />);
    expect((screen.getByLabelText("任せる目的") as HTMLTextAreaElement).value).toBe(
      "手で調整した目的",
    );
    fireEvent.click(screen.getByRole("button", { name: "この範囲で任せる" }));
    await waitFor(() =>
      expect(saveAutonomyContract).toHaveBeenCalledExactlyOnceWith({
        ...contract,
        goal: "手で調整した目的",
        intervalMinutes: 60,
        maxRunsPerDay: 2,
      }),
    );
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
    expect(screen.getByText("今日の仕事を相談")).toBeTruthy();
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
