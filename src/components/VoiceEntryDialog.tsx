import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export type VoiceEntryDialogMode = "switch" | "setup";

export interface VoiceEntryDialogStrings {
  readonly title: string;
  readonly switchBody: string;
  readonly setupBody: string;
  readonly cancel: string;
  readonly confirmSwitch: string;
  readonly openSettings: string;
}

export interface VoiceEntryDialogProps {
  readonly mode: VoiceEntryDialogMode;
  readonly strings: VoiceEntryDialogStrings;
  readonly onCancel: () => void;
  readonly onConfirmSwitch: () => void;
  readonly onOpenSettings: () => void;
}

export function VoiceEntryDialog({
  mode,
  strings,
  onCancel,
  onConfirmSwitch,
  onOpenSettings,
}: VoiceEntryDialogProps): React.ReactPortal | null {
  const titleId = useId();
  const bodyId = useId();
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  if (typeof document === "undefined") return null;

  return createPortal(
    <div className="restore-confirm-overlay" data-surface="themed">
      <button
        aria-hidden="true"
        aria-label={strings.cancel}
        className="restore-confirm-backdrop"
        onMouseDown={(event) => {
          event.preventDefault();
          onCancel();
        }}
        tabIndex={-1}
        type="button"
      />
      <div
        aria-describedby={bodyId}
        aria-labelledby={titleId}
        aria-modal="true"
        className="restore-confirm-panel"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        role="dialog"
      >
        <h2 className="restore-confirm-title" id={titleId}>
          {strings.title}
        </h2>
        <p className="restore-confirm-body" id={bodyId}>
          {mode === "switch" ? strings.switchBody : strings.setupBody}
        </p>
        <div className="restore-confirm-footer">
          <button
            className="restore-confirm-button restore-confirm-button-secondary"
            onClick={onCancel}
            ref={cancelRef}
            type="button"
          >
            {strings.cancel}
          </button>
          <button
            className="restore-confirm-button restore-confirm-button-primary"
            onClick={mode === "switch" ? onConfirmSwitch : onOpenSettings}
            type="button"
          >
            {mode === "switch" ? strings.confirmSwitch : strings.openSettings}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
