import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type RestoreConfirmSurface = "themed" | "crash";

export interface RestoreConfirmStrings {
  readonly title: string;
  readonly body: string;
  readonly cancel: string;
  readonly confirm: string;
  readonly restoring: string;
  readonly done: string;
  readonly failed: string;
  readonly close: string;
  readonly retry: string;
}

export interface RestoreConfirmDialogProps {
  readonly seq: number;
  readonly changeText: string;
  readonly timeText: string;
  readonly surface: RestoreConfirmSurface;
  readonly strings: RestoreConfirmStrings;
  readonly onConfirm: () => Promise<void>;
  readonly onClose: () => void;
}

type RestoreConfirmPhase = "confirm" | "restoring" | "done" | "error";

const RELOAD_DELAY_MS = 650;

function formatBody(template: string, changeText: string, timeText: string): string {
  const withChange = template.replace("{change}", changeText);
  if (timeText.trim().length === 0) {
    return withChange
      .replace(/\s*\({time}\)/, "")
      .replace(/（{time}）/, "")
      .replace("{time}", "");
  }
  return withChange.replace("{time}", timeText);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function focusableElements(root: HTMLElement): HTMLElement[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((el) => !el.hasAttribute("aria-hidden"));
}

function reloadDelayMs(): number {
  if (typeof window === "undefined") return RELOAD_DELAY_MS;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ? 0 : RELOAD_DELAY_MS;
}

/**
 * restore 確認用の in-app overlay。native dialog の中央寄せ/アプリ名 prefix を避け、
 * settings と crash の両方で同じ復元 flow を使う。
 */
export function RestoreConfirmDialog({
  changeText,
  onClose,
  onConfirm,
  seq,
  strings,
  surface,
  timeText,
}: RestoreConfirmDialogProps): React.ReactPortal | null {
  const [phase, setPhase] = useState<RestoreConfirmPhase>("confirm");
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const titleId = useMemo(() => `restore-confirm-title-${seq}`, [seq]);
  const bodyId = useMemo(() => `restore-confirm-body-${seq}`, [seq]);
  const canClose = phase === "confirm" || phase === "error";
  const bodyText = formatBody(strings.body, changeText, timeText);

  useEffect(() => {
    if (phase === "confirm" || phase === "error") {
      cancelRef.current?.focus();
    }
  }, [phase]);

  useEffect(() => {
    if (phase !== "done") return;
    const timer = window.setTimeout(() => {
      window.location.reload();
    }, reloadDelayMs());
    return () => window.clearTimeout(timer);
  }, [phase]);

  const runConfirm = useCallback(async () => {
    if (phase === "restoring" || phase === "done") return;
    setPhase("restoring");
    setError(null);
    try {
      await onConfirm();
      setPhase("done");
    } catch (err) {
      setError(errorMessage(err));
      setPhase("error");
    }
  }, [onConfirm, phase]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === "Escape" && canClose) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || dialogRef.current === null) return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    },
    [canClose, onClose],
  );

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="restore-confirm-overlay" data-surface={surface}>
      <button
        aria-hidden="true"
        aria-label={strings.cancel}
        className="restore-confirm-backdrop"
        disabled={!canClose}
        onMouseDown={(event) => {
          event.preventDefault();
          onClose();
        }}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="restore-confirm-panel"
        onKeyDown={handleKeyDown}
        ref={dialogRef}
        role="dialog"
      >
        <h2 className="restore-confirm-title" id={titleId}>
          {strings.title}
        </h2>
        <p className="restore-confirm-body" id={bodyId}>
          {phase === "done" ? strings.done : bodyText}
        </p>
        {phase === "error" ? (
          <p className="restore-confirm-error" role="alert">
            {strings.failed}: {error}
          </p>
        ) : null}
        <div className="restore-confirm-footer">
          {phase === "confirm" ? (
            <>
              <button
                className="restore-confirm-button restore-confirm-button-secondary"
                onClick={onClose}
                ref={cancelRef}
                type="button"
              >
                {strings.cancel}
              </button>
              <button
                className="restore-confirm-button restore-confirm-button-primary"
                onClick={() => void runConfirm()}
                type="button"
              >
                {strings.confirm}
              </button>
            </>
          ) : null}
          {phase === "restoring" ? (
            <button
              className="restore-confirm-button restore-confirm-button-primary"
              disabled
              type="button"
            >
              {strings.restoring}
            </button>
          ) : null}
          {phase === "error" ? (
            <>
              <button
                className="restore-confirm-button restore-confirm-button-secondary"
                onClick={onClose}
                ref={cancelRef}
                type="button"
              >
                {strings.close}
              </button>
              <button
                className="restore-confirm-button restore-confirm-button-primary"
                onClick={() => void runConfirm()}
                type="button"
              >
                {strings.retry}
              </button>
            </>
          ) : null}
        </div>
      </div>
    </div>,
    document.body,
  );
}
