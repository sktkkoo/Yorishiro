import { ArrowUp, Mic, MicOff, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

export interface QuickChatInputStrings {
  readonly placeholder: string;
  readonly inputLabel: string;
  readonly send: string;
  readonly close: string;
}

export interface QuickChatInputProps {
  readonly value: string;
  readonly strings: QuickChatInputStrings;
  readonly onChange: (value: string) => void;
  readonly onSubmit: () => void;
  readonly onClose: () => void;
}

export interface QuickVoiceIndicatorProps {
  readonly status: "connecting" | "active" | "error";
  readonly muted: boolean;
  readonly connectingLabel: string;
  readonly activeLabel: string;
  readonly mutedLabel: string;
  readonly errorLabel: string;
  readonly muteLabel: string;
  readonly unmuteLabel: string;
  readonly shortcutMuteLabel: string;
  readonly shortcutUnmuteLabel: string;
  readonly stopLabel: string;
  readonly onToggleMuted: () => void;
  readonly onStop: () => void;
}

export function QuickChatInput({
  value,
  strings,
  onChange,
  onSubmit,
  onClose,
}: QuickChatInputProps): React.ReactPortal | null {
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  if (typeof document === "undefined") return null;
  const canSubmit = value.trim().length > 0;
  const submit = () => {
    if (canSubmit) onSubmit();
  };

  return createPortal(
    <div className="quick-chat-layer" data-no-window-drag>
      <form
        aria-label={strings.inputLabel}
        className="quick-chat-palette"
        onSubmit={(event) => {
          event.preventDefault();
          submit();
        }}
        role="dialog"
      >
        <input
          aria-label={strings.inputLabel}
          autoComplete="off"
          className="quick-chat-input"
          enterKeyHint="send"
          onChange={(event) => onChange(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          placeholder={strings.placeholder}
          ref={inputRef}
          spellCheck
          type="text"
          value={value}
        />
        <button
          aria-label={strings.send}
          className="quick-chat-send"
          disabled={!canSubmit}
          title={strings.send}
          type="submit"
        >
          <ArrowUp aria-hidden="true" size={17} strokeWidth={2.25} />
        </button>
        <span className="quick-chat-shortcut" aria-hidden="true" title={strings.close}>
          esc
        </span>
      </form>
    </div>,
    document.body,
  );
}

export function QuickVoiceIndicator({
  status,
  muted,
  connectingLabel,
  activeLabel,
  mutedLabel,
  errorLabel,
  muteLabel,
  unmuteLabel,
  shortcutMuteLabel,
  shortcutUnmuteLabel,
  stopLabel,
  onToggleMuted,
  onStop,
}: QuickVoiceIndicatorProps): React.ReactPortal | null {
  if (typeof document === "undefined") return null;
  const statusLabel =
    status === "active"
      ? muted
        ? mutedLabel
        : activeLabel
      : status === "error"
        ? errorLabel
        : connectingLabel;

  return createPortal(
    <div className="quick-chat-layer" data-no-window-drag>
      <div className="quick-voice-palette" role="status">
        <button
          aria-label={muted ? unmuteLabel : muteLabel}
          aria-pressed={!muted}
          className="quick-voice-icon"
          data-active={status === "active" && !muted}
          disabled={status !== "active"}
          onClick={onToggleMuted}
          title={muted ? unmuteLabel : muteLabel}
          type="button"
        >
          {muted ? (
            <MicOff aria-hidden="true" size={17} strokeWidth={2.15} />
          ) : (
            <Mic aria-hidden="true" size={17} strokeWidth={2.15} />
          )}
        </button>
        <span className="quick-voice-status">{statusLabel}</span>
        {status === "active" ? (
          <span className="quick-voice-shortcut">
            {muted ? shortcutUnmuteLabel : shortcutMuteLabel}
          </span>
        ) : null}
        <button
          aria-label={stopLabel}
          className="quick-voice-stop"
          onClick={onStop}
          title={stopLabel}
          type="button"
        >
          <X aria-hidden="true" size={15} strokeWidth={2.2} />
        </button>
      </div>
    </div>,
    document.body,
  );
}
