// @vitest-environment jsdom

import { open as choosePath } from "@tauri-apps/plugin-dialog";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  approvePendingWork,
  consultAutonomy,
  declinePendingWork,
  editAutonomyDraft,
  pauseAutonomy,
  runAutonomyNow,
  saveAutonomyContract,
  undoAutonomyRun,
  useAutonomyDraftSnapshot,
  useAutonomyStatus,
} from "../runtime/autonomy/client";
import type {
  AutonomyContract,
  AutonomyDraftSnapshot,
  AutonomyStatus,
} from "../runtime/autonomy/types";
import { AutonomyPanel } from "./AutonomyPanel";

vi.mock("@tauri-apps/plugin-dialog", () => ({ open: vi.fn() }));
vi.mock("../runtime/autonomy/client", () => ({
  useAutonomyStatus: vi.fn(),
  useAutonomyDraftSnapshot: vi.fn(),
  editAutonomyDraft: vi.fn(),
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

const draftDefaults = {
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

    fireEvent.click(screen.getByLabelText("ファイルの退避"));
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
