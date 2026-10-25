// @vitest-environment jsdom

import { openUrl } from "@tauri-apps/plugin-opener";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  acknowledgeAutonomyAction,
  approveAutonomyAction,
  declineAutonomyAction,
} from "../runtime/autonomy/client";
import type { AutonomyAction } from "../runtime/autonomy/types";
import { AutonomyActionReview } from "./AutonomyActionReview";

vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));
vi.mock("../runtime/autonomy/client", () => ({
  acknowledgeAutonomyAction: vi.fn(),
  approveAutonomyAction: vi.fn(),
  declineAutonomyAction: vi.fn(),
}));

const action: AutonomyAction = {
  id: "review-1",
  runId: "run-1",
  kind: "publishPullRequest",
  status: "pending",
  createdAt: 1,
  payloadDigest: "exact-reviewed-digest",
  summary: "入力欄の不具合を修正しました。",
  artifactPath: "/private/review-artifact",
  repository: "owner/repository",
  baseBranch: "main",
  headBranch: "yorishiro/run-1",
  title: "Fix input behavior",
  body: "Preserve input while composing.",
  diff: "--- a/src/input.ts\n+++ b/src/input.ts\n+return true;",
  changedPaths: ["src/input.ts"],
  checks: [{ command: "npm test", exitCode: 0 }],
};

beforeEach(() => {
  vi.mocked(acknowledgeAutonomyAction).mockResolvedValue(undefined);
  vi.mocked(approveAutonomyAction).mockResolvedValue(undefined);
  vi.mocked(declineAutonomyAction).mockResolvedValue(undefined);
  vi.mocked(openUrl).mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("post-work confirmation", () => {
  it("acknowledges an unknown result without retrying or claiming to undo it", async () => {
    const view = render(
      <AutonomyActionReview action={{ ...action, status: "unknown" }} disabled={false} />,
    );
    expect(screen.getByText(/GitHub上の作成物は取り消しません/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "確認を終了" }));
    await waitFor(() =>
      expect(acknowledgeAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id),
    );
    expect(approveAutonomyAction).not.toHaveBeenCalled();
    expect(declineAutonomyAction).not.toHaveBeenCalled();
    view.rerender(
      <AutonomyActionReview
        action={{ ...action, status: "unknown", acknowledged: true }}
        disabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "確認を終了" })).toBeNull();
    expect(screen.getByText("結果不明・確認終了")).toBeTruthy();
  });

  it("shows the actual destination, payload and diff without sending anything", () => {
    render(<AutonomyActionReview action={action} disabled={false} />);
    expect(screen.getByText(action.repository)).toBeTruthy();
    expect(screen.getByText(action.baseBranch)).toBeTruthy();
    expect(screen.getByText(action.title)).toBeTruthy();
    expect(screen.getByText(action.body)).toBeTruthy();
    expect(
      screen.getByText(
        (_, element) => element?.tagName === "PRE" && element.textContent === action.diff,
      ),
    ).toBeTruthy();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
    expect(declineAutonomyAction).not.toHaveBeenCalled();
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
    const button = screen.getByRole("button", { name: "承認してPRを作成" });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(approveAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id, action.payloadDigest);
    expect((screen.getByRole("button", { name: "見送る" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    await act(async () => finish());
  });

  it("declines without requesting publication", async () => {
    render(<AutonomyActionReview action={action} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "見送る" }));
    await waitFor(() => expect(declineAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id));
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("can dismiss a known unsent failure without submitting again", async () => {
    render(<AutonomyActionReview action={{ ...action, status: "failed" }} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "公開を見送る" }));
    await waitFor(() => expect(declineAutonomyAction).toHaveBeenCalledExactlyOnceWith(action.id));
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it.each([
    "submitting",
    "unknown",
    "published",
    "declined",
    "failed",
  ] as const)("does not offer another send when status is %s", (status) => {
    render(<AutonomyActionReview action={{ ...action, status }} disabled={false} />);
    expect(screen.queryByRole("button", { name: "承認してPRを作成" })).toBeNull();
    expect(screen.queryByRole("button", { name: "見送る" })).toBeNull();
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("opens the fixed GitHub destination after an unknown outcome without resending", async () => {
    render(<AutonomyActionReview action={{ ...action, status: "unknown" }} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "GitHubで確認" }));
    await waitFor(() =>
      expect(openUrl).toHaveBeenCalledExactlyOnceWith("https://github.com/owner/repository/pulls"),
    );
    expect(approveAutonomyAction).not.toHaveBeenCalled();
  });

  it("does not open a PR URL for another repository or scheme", () => {
    render(
      <AutonomyActionReview
        action={{
          ...action,
          status: "published",
          pullRequestUrl: "https://github.com/other/repository/pull/1",
        }}
        disabled={false}
      />,
    );
    expect(screen.queryByRole("button", { name: "ドラフトPRを開く" })).toBeNull();
  });

  it("refuses approval for a malformed destination", () => {
    render(
      <AutonomyActionReview action={{ ...action, repository: "../secret" }} disabled={false} />,
    );
    expect(
      (screen.getByRole("button", { name: "承認してPRを作成" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("surfaces an approval failure without claiming success", async () => {
    vi.mocked(approveAutonomyAction).mockRejectedValue(new Error("成果物が変更されています"));
    render(<AutonomyActionReview action={action} disabled={false} />);
    fireEvent.click(screen.getByRole("button", { name: "承認してPRを作成" }));
    expect((await screen.findByRole("alert")).textContent).toBe("成果物が変更されています");
    expect(screen.queryByText("PR作成済み")).toBeNull();
  });
});
