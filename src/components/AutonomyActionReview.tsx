import { useId, useRef, useState } from "react";
import { approveAutonomyAction, declineAutonomyAction } from "../runtime/autonomy/client";
import type { AutonomyAction } from "../runtime/autonomy/types";

const STATUS_LABELS = {
  pending: "確認待ち",
  approved: "承認済み（実行は未確認）",
  declined: "見送り",
};

/** Records a decision about this exact request; it does not execute the operation. */
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
      {action.status === "pending" && (
        <>
          <p id={hintId} className="autonomy-muted">
            表示した操作への承認を記録します。このボタンでは操作を実行しません。担当AIが承認結果を確認できます。
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
              {busy ? "記録しています…" : "承認する"}
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
            承認を記録しました。実行はまだ確認されていません。承認結果はAIから参照できます。別の操作や変更された内容には適用されません。
          </p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void perform(() => declineAutonomyAction(action.id))}
          >
            承認を取り消す
          </button>
          <p className="autonomy-muted">
            取り消しは承認の記録にだけ適用されます。実行済みの操作を元に戻すことはできません。
          </p>
        </>
      )}
      {action.status === "declined" && (
        <p className="autonomy-muted">この操作を見送りました。成果物は保存されています。</p>
      )}
    </article>
  );
}
