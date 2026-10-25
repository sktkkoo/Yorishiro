import { openUrl } from "@tauri-apps/plugin-opener";
import { useId, useRef, useState } from "react";
import {
  acknowledgeAutonomyAction,
  approveAutonomyAction,
  declineAutonomyAction,
} from "../runtime/autonomy/client";
import type { AutonomyAction } from "../runtime/autonomy/types";

const STATUS_LABELS = {
  pending: "確認待ち",
  submitting: "PRを作成中",
  published: "PR作成済み",
  declined: "見送り",
  failed: "作成できませんでした",
  unknown: "公開結果を確認してください",
};

function repositoryUrl(repository: string): string | null {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*\/[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(repository)
    ? `https://github.com/${repository}`
    : null;
}

/** Approves only the concrete immutable payload shown in this card. */
export function AutonomyActionReview({
  action,
  disabled,
}: {
  readonly action: AutonomyAction;
  readonly disabled: boolean;
}) {
  const titleId = useId();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const repository = repositoryUrl(action.repository);
  const prUrl =
    repository &&
    action.pullRequestUrl?.startsWith(`${repository}/pull/`) &&
    /^[1-9][0-9]*$/.test(action.pullRequestUrl.slice(`${repository}/pull/`.length))
      ? action.pullRequestUrl
      : null;

  async function perform(operation: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <article className="autonomy-action-review" aria-labelledby={titleId}>
      <div className="autonomy-run-meta">
        <span className={`autonomy-run-badge autonomy-action-${action.status}`}>
          {action.status === "unknown" && action.acknowledged
            ? "結果不明・確認終了"
            : STATUS_LABELS[action.status]}
        </span>
        <h3 id={titleId}>PRの公開</h3>
      </div>
      <p>{action.summary}</p>
      <dl className="autonomy-publication-fields">
        <div>
          <dt>公開先</dt>
          <dd>{action.repository}</dd>
        </div>
        <div>
          <dt>ベースブランチ</dt>
          <dd>{action.baseBranch}</dd>
        </div>
        <div>
          <dt>作成するブランチ</dt>
          <dd>{action.headBranch}</dd>
        </div>
        <div>
          <dt>PRタイトル</dt>
          <dd>{action.title}</dd>
        </div>
      </dl>
      <details className="autonomy-run-details" open>
        <summary>PR本文</summary>
        <pre className="autonomy-review-content">{action.body}</pre>
      </details>
      <details className="autonomy-run-details" open>
        <summary>変更差分（{action.changedPaths.length}ファイル）</summary>
        <ul>
          {action.changedPaths.map((path) => (
            <li key={path} className="autonomy-path">
              {path}
            </li>
          ))}
        </ul>
        <pre className="autonomy-review-content autonomy-review-diff">
          {action.diff || "表示できる差分はありません。"}
        </pre>
      </details>
      <details className="autonomy-run-details">
        <summary>成果物と検証結果</summary>
        <p className="autonomy-path">{action.artifactPath}</p>
        <pre className="autonomy-review-content">
          {action.checks.map((check) => `${check.command}: exit ${check.exitCode}`).join("\n") ||
            "検証結果はありません。"}
        </pre>
      </details>
      {(error || action.error) && (
        <p role="alert" className="autonomy-error">
          {error || action.error}
        </p>
      )}
      {action.status === "pending" && (
        <>
          <p id={hintId} className="autonomy-muted">
            承認すると、表示した変更・タイトル・本文をGitHubへ送信し、ドラフトPRを作成します。マージはしません。
          </p>
          <div className="autonomy-actions">
            <button
              type="button"
              className="autonomy-primary"
              aria-describedby={hintId}
              disabled={disabled || busy || !repository || !action.payloadDigest}
              onClick={() =>
                void perform(() => approveAutonomyAction(action.id, action.payloadDigest))
              }
            >
              {busy ? "処理しています…" : "承認してPRを作成"}
            </button>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void perform(() => declineAutonomyAction(action.id))}
            >
              見送る
            </button>
          </div>
        </>
      )}
      {action.status === "submitting" && (
        <p role="status">
          GitHubへの送信結果を確認しています。送信済みの操作は、停止しても取り消せません。
        </p>
      )}
      {action.status === "unknown" && (
        <p className="autonomy-muted">
          PRまたはブランチが作成された可能性があります。GitHubで確認してください。自動で再送しません。
        </p>
      )}
      {action.status === "failed" && (
        <>
          <p className="autonomy-muted">
            PRやブランチの作成は開始されていません。表示された理由を解消後、作業履歴の「変更を確認」から新しい確認を作成できます。
          </p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void perform(() => declineAutonomyAction(action.id))}
          >
            公開を見送る
          </button>
        </>
      )}
      {action.status === "declined" && (
        <p className="autonomy-muted">公開を見送りました。成果物は保存されています。</p>
      )}
      {prUrl && (
        <button type="button" onClick={() => void perform(() => openUrl(prUrl))} disabled={busy}>
          ドラフトPRを開く
        </button>
      )}
      {action.status === "unknown" && repository && (
        <button
          type="button"
          onClick={() => void perform(() => openUrl(`${repository}/pulls`))}
          disabled={busy}
        >
          GitHubで確認
        </button>
      )}
      {action.status === "unknown" && !action.acknowledged && (
        <>
          <p className="autonomy-muted">
            確認を終了しても再送しません。GitHub上の作成物は取り消しません。自動作業がOnの場合、範囲内のローカル作業を再開できます。
          </p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void perform(() => acknowledgeAutonomyAction(action.id))}
          >
            確認を終了
          </button>
        </>
      )}
    </article>
  );
}
