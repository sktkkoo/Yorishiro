import type { CodexRealtimeStatus } from "./codex-realtime";

const QUICK_CHAT_VIEW_MODE_IDS = new Set(["companion", "portrait", "theater"]);

/** Host-owned quick chat is available only in the bundled character-first View Modes. */
export function supportsQuickChatForViewMode(viewModeId: string | null): boolean {
  return viewModeId !== null && QUICK_CHAT_VIEW_MODE_IDS.has(viewModeId);
}

/** Text Quick Chat remains available only while GPT Live is fully idle. */
export function canUseQuickChat(
  conversationShortcutEnabled: boolean,
  realtimeStatus: CodexRealtimeStatus,
): boolean {
  return conversationShortcutEnabled && realtimeStatus === "idle";
}

interface ModifierTapTarget {
  addEventListener(type: "keydown" | "keyup", listener: (event: KeyboardEvent) => void): void;
  addEventListener(type: "blur" | "pointerdown", listener: () => void): void;
  removeEventListener(type: "keydown" | "keyup", listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: "blur" | "pointerdown", listener: () => void): void;
}

export interface QuickChatKeybindingOptions {
  readonly macos: boolean;
  readonly onInvoke: () => void;
  readonly onHoldStart?: () => void;
  readonly onHoldEnd?: () => void;
  readonly holdDelayMs?: number;
  readonly target?: ModifierTapTarget;
}

/**
 * Invoke quick chat only when Command (Control outside macOS) is tapped by itself.
 * Waiting for keyup lets ordinary chords such as Command+R and Option+Command+1
 * cancel the gesture before it can open the palette.
 */
export function installQuickChatKeybinding({
  macos,
  onInvoke,
  onHoldStart,
  onHoldEnd,
  holdDelayMs = 360,
  target = window,
}: QuickChatKeybindingOptions): () => void {
  const modifier = macos ? "Meta" : "Control";
  let armed = false;
  let activeModifierCode: string | null = null;
  let holdStarted = false;
  let holdTimer: number | null = null;

  const clearHoldTimer = () => {
    if (holdTimer === null) return;
    window.clearTimeout(holdTimer);
    holdTimer = null;
  };
  const finishHold = () => {
    if (!holdStarted) return;
    holdStarted = false;
    onHoldEnd?.();
  };
  const cancel = () => {
    clearHoldTimer();
    armed = false;
    activeModifierCode = null;
    finishHold();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === modifier) {
      if (event.repeat) return;
      const bareModifier = macos
        ? !event.altKey && !event.ctrlKey && !event.shiftKey
        : !event.altKey && !event.metaKey && !event.shiftKey;
      if (!bareModifier || activeModifierCode !== null) {
        cancel();
        return;
      }
      armed = true;
      activeModifierCode = event.code;
      if (onHoldStart) {
        holdTimer = window.setTimeout(() => {
          holdTimer = null;
          if (!armed) return;
          armed = false;
          holdStarted = true;
          onHoldStart();
        }, holdDelayMs);
      }
      return;
    }

    if ((macos && event.metaKey) || (!macos && event.ctrlKey)) cancel();
  };
  const onKeyUp = (event: KeyboardEvent) => {
    if (event.key !== modifier || event.code !== activeModifierCode) return;
    clearHoldTimer();
    activeModifierCode = null;
    if (holdStarted) {
      event.preventDefault();
      event.stopPropagation();
      finishHold();
      return;
    }
    const invoke = armed;
    armed = false;
    if (!invoke) return;
    event.preventDefault();
    event.stopPropagation();
    onInvoke();
  };

  target.addEventListener("keydown", onKeyDown);
  target.addEventListener("keyup", onKeyUp);
  target.addEventListener("blur", cancel);
  target.addEventListener("pointerdown", cancel);
  return () => {
    cancel();
    target.removeEventListener("keydown", onKeyDown);
    target.removeEventListener("keyup", onKeyUp);
    target.removeEventListener("blur", cancel);
    target.removeEventListener("pointerdown", cancel);
  };
}
