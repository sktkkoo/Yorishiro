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
  it.each([
    ["ja", "ja-JP", "確認の作成日時"],
    ["en", "en-US", "Request created"],
  ] as const)("dates requests in %s without presenting creation as execution", (language, locale, label) => {
    const createdAt = Date.UTC(2026, 9, 31, 12, 34);
    const date = new Date(createdAt);
    const view = render(
      <AutonomyActionReview
        action={{ ...action, createdAt }}
        language={language}
        disabled={false}
      />,
    );
    const time = view.container.querySelector("time");
    expect(time?.getAttribute("datetime")).toBe(date.toISOString());
    expect(time?.textContent).toBe(
      date.toLocaleString(locale, {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
    expect(time?.parentElement?.textContent).toContain(label);
    view.rerender(
      <AutonomyActionReview
        action={{ ...action, createdAt, status: "completed", autoApproved: true }}
        language={language}
        disabled={false}
      />,
    );
    expect(view.container.querySelector("time")?.getAttribute("datetime")).toBe(date.toISOString());
    expect(view.container.querySelector("time")?.parentElement?.textContent).toContain(label);
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it.each([
    NaN,
    Infinity,
    1e20,
  ])("omits an invalid request date (%s) without hiding the operation", (createdAt) => {
    const view = render(
      <AutonomyActionReview action={{ ...action, createdAt }} disabled={false} />,
    );
    expect(view.container.querySelector("time")).toBeNull();
    expect(screen.getByRole("heading", { name: action.operation })).toBeTruthy();
    expect(screen.getByRole("button", { name: "承認する" })).toBeTruthy();
  });

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
    expect(screen.queryByText("承認済み・実行待ち")).toBeNull();
    expect(screen.queryByText("実行完了")).toBeNull();
    expect((screen.getByRole("button", { name: "見送る" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish());
    expect(screen.getByText("確認待ち")).toBeTruthy();
    expect(screen.queryByText("実行完了")).toBeNull();
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

  it.each([
    "approved",
    "executing",
    "completed",
  ] as const)("distinguishes purpose-based automatic permission from manual approval when %s", (status) => {
    const view = render(
      <AutonomyActionReview action={{ ...action, status, autoApproved: true }} disabled={false} />,
    );
    expect(screen.getByText("目的に基づく自動許可")).toBeTruthy();
    expect(screen.getByText("操作が必要な理由")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "承認する" })).toBeNull();
    if (status === "approved") {
      expect(screen.getByText("自動許可済み・実行待ち")).toBeTruthy();
      expect(screen.getByRole("button", { name: "承認を取り消す" })).toBeTruthy();
    }
    view.rerender(<AutonomyActionReview action={{ ...action, status }} disabled={false} />);
    expect(screen.queryByText("目的に基づく自動許可")).toBeNull();
    expect(screen.getByText("確認が必要な理由")).toBeTruthy();
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
    const notice = screen.getByRole("note");
    expect(notice.textContent).toContain("外部と通信する操作です");
    expect(notice.textContent).toContain("AIが実行方法を選び");
    expect(notice.textContent).toContain("認証を利用できない場合は、未実行として知らせます");
    expect(notice.textContent).not.toContain("保存済みログイン");
    expect(notice.querySelector('[aria-hidden="true"]')?.textContent).toContain("↗");
    expect(notice.closest("details")).toBeNull();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("keeps target, impact and exact details visible while technical evidence is disclosed separately", () => {
    render(
      <AutonomyActionReview
        action={{ ...action, checks: [{ command: "check report", exitCode: 0 }] }}
        disabled={false}
      />,
    );
    expect(screen.getByText(action.target).closest("details")).toBeNull();
    expect(screen.getByText(action.impact).closest("details")).toBeNull();
    const content = screen.getByText("操作の内容").closest("details");
    expect(content?.open).toBe(true);
    expect(content?.querySelector("pre")?.textContent).toBe(action.details);
    const evidence = screen.getByText("作業の記録").closest("details");
    expect(evidence?.open).toBe(false);
    expect(evidence?.textContent).toContain(action.sourceRoot);
    expect(evidence?.textContent).toContain(action.artifactPath);
    expect(evidence?.textContent).toContain("draft.md");
    expect(evidence?.textContent).toContain("check report: exit 0");
    fireEvent.click(screen.getByText("作業の記録"));
    expect(evidence?.open).toBe(true);
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("localizes the English decision controls without translating or changing the frozen contents", async () => {
    render(
      <AutonomyActionReview
        action={{ ...action, networkAccess: true }}
        language="en"
        disabled={false}
      />,
    );
    expect(screen.getByText("Needs your approval")).toBeTruthy();
    expect(screen.getByText("Target")).toBeTruthy();
    expect(screen.getByText("Impact")).toBeTruthy();
    expect(screen.getByText("Why approval is needed")).toBeTruthy();
    expect(screen.getByText("Exact operation details").closest("details")?.open).toBe(true);
    expect(screen.getByText("Work record").closest("details")?.textContent).toContain(
      action.sourceRoot,
    );
    expect(screen.getByRole("note").textContent).toContain("AI chooses how");
    expect(screen.getByRole("note").textContent).toContain("authentication is unavailable");
    expect(screen.getByRole("note").textContent).toContain("not executed");
    expect(screen.getByRole("note").textContent).not.toContain("saved login");
    expect(screen.getByRole("heading", { name: action.operation })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "承認する" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() =>
      expect(approveAutonomyAction).toHaveBeenCalledExactlyOnceWith(
        action.id,
        action.payloadDigest,
      ),
    );
    expect(screen.queryByText("Approved · queued")).toBeNull();
    expect(screen.queryByText("Completed")).toBeNull();
  });

  it("localizes saved automatic permission and cancellation in English", async () => {
    render(
      <AutonomyActionReview
        action={{ ...action, status: "approved", autoApproved: true }}
        language="en"
        disabled={false}
      />,
    );
    expect(screen.getByText("Automatically authorized · queued")).toBeTruthy();
    expect(screen.getByText("Automatic permission for your goal")).toBeTruthy();
    expect(screen.getByText(/automatic permission you saved/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel approval" }));
    await waitFor(() => expect(declineAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id));
  });

  it.each([
    ["executing", "In progress"],
    ["completed", "Completed"],
    ["failed", "Failed"],
    ["interrupted", "Check the outcome"],
    ["declined", "Skipped"],
  ] as const)("localizes the English %s result without offering another approval", (status, label) => {
    render(<AutonomyActionReview action={{ ...action, status }} language="en" disabled={false} />);
    expect(screen.getByText(label)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("opens a safe English result only on request and keeps unsafe links unavailable", async () => {
    const resultUrl = "https://team.example.test/reports/42";
    const view = render(
      <AutonomyActionReview
        action={{ ...action, status: "completed", resultUrl }}
        language="en"
        disabled={false}
      />,
    );
    expect(openUrl).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Open result" }));
    await waitFor(() => expect(openUrl).toHaveBeenCalledExactlyOnceWith(resultUrl));
    view.rerender(
      <AutonomyActionReview
        action={{ ...action, status: "completed", resultUrl: "javascript:alert(1)" }}
        language="en"
        disabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "Open result" })).toBeNull();
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
