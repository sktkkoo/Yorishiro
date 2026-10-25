import { openUrl } from "@tauri-apps/plugin-opener";
import { useId, useRef, useState } from "react";
import { approveAutonomyAction, declineAutonomyAction } from "../runtime/autonomy/client";
import type { AutonomyAction } from "../runtime/autonomy/types";

const STATUS_LABELS = {
  pending: "確認待ち",
  approved: "承認済み・実行待ち",
  executing: "実行中",
  completed: "実行完了",
  failed: "実行失敗",
  interrupted: "実行結果の確認が必要",
  declined: "見送り",
};

function resultLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Reviews the exact operation and shows its execution outcome. */
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
  const resultUrl = resultLink(action.resultUrl);

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
          {STATUS_LABELS[action.status]}
        </span>
        <h3 id={titleId}>{action.operation}</h3>
      </div>
      <dl className="autonomy-action-fields">
        <div>
          <dt>対象フォルダ</dt>
          <dd>{action.sourceRoot}</dd>
        </div>
        <div>
          <dt>対象</dt>
          <dd>{action.target}</dd>
        </div>
        <div>
          <dt>影響</dt>
          <dd>{action.impact}</dd>
        </div>
        <div>
          <dt>確認が必要な理由</dt>
          <dd>{action.summary}</dd>
        </div>
      </dl>
      <details className="autonomy-run-details" open>
        <summary>操作の内容</summary>
        <pre className="autonomy-review-content">{action.details}</pre>
      </details>
      {action.networkAccess && (
        <p className="autonomy-muted">承認した対象への通信を含む操作です。</p>
      )}
      {(action.artifactPath || action.changedPaths.length > 0 || action.checks.length > 0) && (
        <details className="autonomy-run-details">
          <summary>成果物と検証結果</summary>
          {action.artifactPath && <p className="autonomy-path">{action.artifactPath}</p>}
          {action.changedPaths.length > 0 && (
            <ul>
              {action.changedPaths.map((path) => (
                <li key={path} className="autonomy-path">
                  {path}
                </li>
              ))}
            </ul>
          )}
          {action.checks.length > 0 && (
            <pre className="autonomy-review-content">
              {action.checks.map((check) => `${check.command}: exit ${check.exitCode}`).join("\n")}
            </pre>
          )}
        </details>
      )}
      {(error || action.error) && (
        <p role="alert" className="autonomy-error">
          {error || action.error}
        </p>
      )}
      {action.executionSummary && (
        <p className="autonomy-execution-result">{action.executionSummary}</p>
      )}
      {resultUrl && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void perform(() => openUrl(resultUrl))}
        >
          実行結果を開く
        </button>
      )}
      {action.status === "pending" && (
        <>
          <p id={hintId} className="autonomy-muted">
            承認した内容で実行します。対象・影響・操作の内容を確認してください。
          </p>
          <div className="autonomy-actions">
            <button
              type="button"
              className="autonomy-primary"
              aria-describedby={hintId}
              disabled={disabled || busy || !action.payloadDigest}
              onClick={() =>
                void perform(() => approveAutonomyAction(action.id, action.payloadDigest))
              }
            >
              {busy ? "開始しています…" : "承認する"}
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
      {action.status === "approved" && (
        <>
          <p className="autonomy-muted">
            承認した操作の実行を準備しています。実行が始まるまでは承認を取り消せます。
          </p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void perform(() => declineAutonomyAction(action.id))}
          >
            承認を取り消す
          </button>
        </>
      )}
      {action.status === "executing" && (
        <p className="autonomy-muted">承認した内容で実行しています。</p>
      )}
      {action.status === "failed" && (
        <p className="autonomy-muted">
          操作は完了しませんでした。表示された結果を確認してください。自動では再実行しません。
        </p>
      )}
      {action.status === "interrupted" && (
        <p className="autonomy-muted">
          実行が中断され、完了したか確認できません。対象の状態を確認してください。重複を避けるため自動では再実行しません。
        </p>
      )}
      {action.status === "declined" && (
        <p className="autonomy-muted">この操作を見送りました。成果物は保存されています。</p>
      )}
    </article>
  );
}
