// @vitest-environment jsdom

import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { approveAutonomyAction, declineAutonomyAction } from "../runtime/autonomy/client";
import type { AutonomyAction } from "../runtime/autonomy/types";
import { AutonomyActionReview } from "./AutonomyActionReview";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

vi.mock("../runtime/autonomy/client", () => ({
  approveAutonomyAction: vi.fn(),
  declineAutonomyAction: vi.fn(),
}));

const action: AutonomyAction = {
  id: "review-1",
  runId: "run-1",
  kind: "operation",
  status: "pending",
  createdAt: 1,
  payloadDigest: "exact-reviewed-digest",
  summary: "メールの送信は受信者に影響するため確認が必要です。",
  sourceRoot: "/Users/test/notes",
  operation: "打ち合わせ結果をメールで送信",
  target: "colleague@example.com",
  impact: "受信者にメールが届き、送信後は取り消せません。",
  details: "宛先: colleague@example.com\n件名: 打ち合わせ結果\n本文: 次回は金曜の10時です。",
  artifactPath: "/Users/test/notes/draft.md",
  changedPaths: ["draft.md"],
  checks: [],
};

beforeEach(() => {
  vi.mocked(openUrl).mockResolvedValue(undefined);
  vi.mocked(approveAutonomyAction).mockResolvedValue(undefined);
  vi.mocked(declineAutonomyAction).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("post-work operation confirmation", () => {
  it("shows a non-Git operation, target, impact and exact contents without executing", () => {
    render(<AutonomyActionReview action={action} disabled={false} />);
    expect(screen.getByRole("heading", { name: action.operation })).toBeTruthy();
    expect(screen.getByText(action.sourceRoot)).toBeTruthy();
    expect(screen.getByText(action.target)).toBeTruthy();
    expect(screen.getByText(action.impact)).toBeTruthy();
    expect(
      screen.getByText((_, node) => node?.tagName === "PRE" && node.textContent === action.details),
    ).toBeTruthy();
    expect(screen.getByText(/承認した内容で実行します/)).toBeTruthy();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
    expect(declineAutonomyAction).not.toHaveBeenCalled();
    expect(screen.queryByText(/GitHub|PRの公開/)).toBeNull();
  });

  it("approves the displayed request and digest once even with repeated clicks", async () => {
    let finish: () => void = () => {};
    vi.mocked(approveAutonomyAction).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(<AutonomyActionReview action={action} disabled={false} />);
    const button = screen.getByRole("button", { name: "承認する" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(approveAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id, action.payloadDigest);
    expect((screen.getByRole("button", { name: "見送る" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish());
  });

  it("declines without approving or running the operation", async () => {
    render(<AutonomyActionReview action={action} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "見送る" }));
    await waitFor(() => expect(declineAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id));
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("shows queued approval and permits revoking before execution starts", async () => {
    render(<AutonomyActionReview action={{ ...action, status: "approved" }} disabled={false} />);
    expect(screen.getByText("承認済み・実行待ち")).toBeTruthy();
    expect(screen.getByText(/実行が始まるまでは承認を取り消せます/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "承認する" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "承認を取り消す" }));
    await waitFor(() => expect(declineAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id));
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("retains the declined request without offering another approval", () => {
    render(<AutonomyActionReview action={{ ...action, status: "declined" }} disabled={false} />);
    expect(screen.getByText("見送り")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByRole("heading", { name: action.operation })).toBeTruthy();
  });

  it("shows execution in progress without offering approval or revocation", () => {
    render(<AutonomyActionReview action={{ ...action, status: "executing" }} disabled={false} />);
    expect(screen.getByText("実行中")).toBeTruthy();
    expect(screen.getByText("承認した内容で実行しています。")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("displays the completed operation and opens its result only on request", async () => {
    const resultUrl = "https://team.example.test/reports/42";
    render(
      <AutonomyActionReview
        action={{
          ...action,
          status: "completed",
          executionSummary: "指定した共有先へ報告書を配置しました。",
          resultUrl,
        }}
        disabled={false}
      />,
    );
    expect(screen.getByText("実行完了")).toBeTruthy();
    expect(screen.getByText("指定した共有先へ報告書を配置しました。")).toBeTruthy();
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "実行結果を開く" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith(resultUrl));
    expect(screen.queryByRole("button", { name: "承認する" })).toBeNull();
  });

  it.each([
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:secret@example.test",
  ])("does not offer an unsafe result link: %s", (resultUrl) => {
    render(
      <AutonomyActionReview
        action={{ ...action, status: "completed", resultUrl }}
        disabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "実行結果を開く" })).toBeNull();
    expect(openUrl).not.toHaveBeenCalled();
  });

  it.each([
    "failed",
    "interrupted",
  ] as const)("shows a %s outcome without silently replaying the operation", (status) => {
    render(
      <AutonomyActionReview
        action={{ ...action, status, error: "操作先の状態を確認してください" }}
        disabled={false}
      />,
    );
    expect(screen.getByRole("alert").textContent).toBe("操作先の状態を確認してください");
    expect(screen.getByText(/自動では再実行しません/)).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("includes communication in the reviewed operation when requested", () => {
    render(<AutonomyActionReview action={{ ...action, networkAccess: true }} disabled={false} />);
    expect(
      screen.getByText(
        "承認した対象への通信を含む操作です。必要に応じて、そのサービスの保存済みログインを使用します。",
      ),
    ).toBeTruthy();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("accepts a file sharing request without repository fields or artifacts", () => {
    render(
      <AutonomyActionReview
        action={{
          ...action,
          operation: "共有フォルダに配置",
          target: "/Volumes/team/report.pdf",
          impact: "チームのメンバーが閲覧できます。",
          artifactPath: null,
          changedPaths: [],
        }}
        disabled={false}
      />,
    );
    expect(screen.getByRole("heading", { name: "共有フォルダに配置" })).toBeTruthy();
    expect(screen.queryByText("成果物と検証結果")).toBeNull();
    expect((screen.getByRole("button", { name: "承認する" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it.each([
    true,
    false,
  ])("prevents approval without a digest or while disabled (%s)", (disabled) => {
    render(
      <AutonomyActionReview
        action={{ ...action, payloadDigest: disabled ? action.payloadDigest : "" }}
        disabled={disabled}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("surfaces a stale-request failure without claiming approval or execution", async () => {
    vi.mocked(approveAutonomyAction).mockRejectedValue(new Error("確認内容が変更されています"));
    render(<AutonomyActionReview action={action} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "承認する" }));
    expect((await screen.findByRole("alert")).textContent).toBe("確認内容が変更されています");
    expect(screen.queryByText("承認済み・実行待ち")).toBeNull();
  });
});
