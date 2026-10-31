import { openUrl } from "@tauri-apps/plugin-opener";
import { useId, useRef, useState } from "react";
import { AUTONOMY_ACTION_COPY } from "../i18n/autonomy-action";
import { approveAutonomyAction, declineAutonomyAction } from "../runtime/autonomy/client";
import type { AutonomyAction } from "../runtime/autonomy/types";
import { resultLink } from "./result-link";

/** Reviews the exact operation and shows its execution outcome. */
export function AutonomyActionReview({
  action,
  disabled,
  language = "ja",
}: {
  readonly action: AutonomyAction;
  readonly disabled: boolean;
  readonly language?: "ja" | "en";
}) {
  const copy = AUTONOMY_ACTION_COPY[language];
  const titleId = useId();
  const hintId = useId();
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const resultUrl = resultLink(action.resultUrl);
  const createdAt = new Date(action.createdAt);
  const validCreatedAt = Number.isFinite(createdAt.getTime());

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
      <header className="autonomy-action-header">
        <div className="autonomy-run-meta">
          <span className={`autonomy-run-badge autonomy-action-${action.status}`}>
            {action.autoApproved && action.status === "approved"
              ? copy.automaticQueued
              : copy.statuses[action.status]}
          </span>
          {action.autoApproved && (
            <span className="autonomy-run-badge">{copy.automaticPermission}</span>
          )}
          {validCreatedAt && (
            <span>
              {copy.createdAt}{" "}
              <time dateTime={createdAt.toISOString()}>
                {createdAt.toLocaleString(language === "ja" ? "ja-JP" : "en-US", {
                  year: "numeric",
                  month: "2-digit",
                  day: "2-digit",
                  hour: "2-digit",
                  minute: "2-digit",
                })}
              </time>
            </span>
          )}
        </div>
        <h3 className="autonomy-action-title" id={titleId}>
          {action.operation}
        </h3>
      </header>
      <dl className="autonomy-action-fields autonomy-action-overview">
        <div>
          <dt>{copy.target}</dt>
          <dd>{action.target}</dd>
        </div>
        <div>
          <dt>{copy.impact}</dt>
          <dd>{action.impact}</dd>
        </div>
      </dl>
      <p className="autonomy-action-reason">
        <span>{action.autoApproved ? copy.automaticReason : copy.reason}</span> {action.summary}
      </p>
      {action.networkAccess && (
        <div className="autonomy-action-network" role="note">
          <span className="autonomy-action-network-icon" aria-hidden="true">
            ↗
          </span>
          <div className="autonomy-action-network-copy">
            <strong>{copy.networkTitle}</strong>
            <p>{copy.networkDescription}</p>
          </div>
        </div>
      )}
      <details
        className="autonomy-run-details autonomy-action-content"
        open={action.status === "pending"}
      >
        <summary>{copy.contents}</summary>
        <pre className="autonomy-review-content">{action.details}</pre>
      </details>
      <details className="autonomy-run-details autonomy-action-evidence">
        <summary>{copy.record}</summary>
        <dl className="autonomy-action-fields">
          <div>
            <dt>{copy.source}</dt>
            <dd className="autonomy-path">{action.sourceRoot}</dd>
          </div>
        </dl>
        {(action.artifactPath || action.changedPaths.length > 0 || action.checks.length > 0) && (
          <>
            <h4>{copy.evidence}</h4>
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
                {action.checks
                  .map((check) => `${check.command}: exit ${check.exitCode}`)
                  .join("\n")}
              </pre>
            )}
          </>
        )}
      </details>
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
          {copy.result}
        </button>
      )}
      {action.status === "pending" && (
        <div className="autonomy-action-footer">
          <p id={hintId} className="autonomy-muted">
            {copy.review}
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
              {busy ? copy.starting : copy.approve}
            </button>
            <button
              type="button"
              disabled={disabled || busy}
              onClick={() => void perform(() => declineAutonomyAction(action.id))}
            >
              {copy.decline}
            </button>
          </div>
        </div>
      )}
      {action.status === "approved" && (
        <div className="autonomy-action-footer">
          <p className="autonomy-muted">
            {action.autoApproved ? copy.automaticPreparation : copy.queued}
          </p>
          <button
            type="button"
            disabled={disabled || busy}
            onClick={() => void perform(() => declineAutonomyAction(action.id))}
          >
            {copy.cancel}
          </button>
        </div>
      )}
      {action.status === "executing" && (
        <p className="autonomy-muted">
          {action.autoApproved ? copy.automaticExecution : copy.executing}
        </p>
      )}
      {action.status === "failed" && <p className="autonomy-muted">{copy.failed}</p>}
      {action.status === "interrupted" && <p className="autonomy-muted">{copy.interrupted}</p>}
      {action.status === "declined" && <p className="autonomy-muted">{copy.declined}</p>}
    </article>
  );
}
