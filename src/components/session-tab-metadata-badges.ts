import type { DispatchEvent, HookSignalEvent, LoopLifecycleEvent } from "@charminal/sdk";
import type { SessionAttention } from "../runtime/session-status/session-status-store";
import type { SessionTabState } from "../runtime/session-tabs/types";
import type { SessionId } from "../runtime/sessions/types";
import type { TabIndicatorBadge } from "./TabIndicator";

const SYSTEM_SYNTHETIC_METADATA_BADGE_NAMES = new Set([
  // Practical allowlist: completion/failure events that are not already visible in tab chrome.
  "charminal-settings:write-failed",
  "pomodoro:session-completed",
  "session-respawn-failed",
]);

export interface SessionTabMetadataBadgeDecision {
  readonly sessionId: SessionId;
  readonly badge: TabIndicatorBadge;
}

export type SessionTabStatusAttentionDecision =
  | {
      readonly action: "mark-loop-blocked";
      readonly sessionId: SessionId;
      readonly notification: Pick<SessionAttention, "title" | "body" | "source">;
    }
  | {
      readonly action: "clear-loop-blocked";
      readonly sessionId: SessionId;
    };

/**
 * EventBus dispatch stream から、top bar の session tab に短時間表示する metadata
 * badge だけを選ぶ。
 *
 * この filter は「タブで見ればユーザーが戻るべきか判断できる event」に限定する。
 * 低レベルで高頻度な event（PTY output / user input / ordinary hook lifecycle）は
 * タブを騒がせるだけなので表示しない。
 */
export function deriveSessionTabMetadataBadge(
  event: DispatchEvent,
  state: SessionTabState,
): SessionTabMetadataBadgeDecision | null {
  const badge = badgeForEvent(event);
  if (badge === null) return null;
  return {
    sessionId: targetSessionIdForEvent(event, state),
    badge,
  };
}

export function deriveSessionTabStatusAttention(
  event: DispatchEvent,
  state: SessionTabState,
): SessionTabStatusAttentionDecision | null {
  if (event.kind !== "loop-lifecycle") return null;
  const sessionId = targetSessionIdForEvent(event, state);

  if (event.phase === "blocked-on-approval") {
    return {
      action: "mark-loop-blocked",
      sessionId,
      notification: {
        title: "Loop",
        body: "Blocked on approval",
        source: "loop",
      },
    };
  }

  return {
    action: "clear-loop-blocked",
    sessionId,
  };
}

function badgeForEvent(event: DispatchEvent): TabIndicatorBadge | null {
  if (event.kind === "synthetic" && event.source.type === "system") {
    if (!SYSTEM_SYNTHETIC_METADATA_BADGE_NAMES.has(event.name)) return null;
    return {
      label: `trigger:${event.name}`,
      tone: "charminal",
      title: `Charminal trigger: ${event.source.packId}/${event.name}`,
    };
  }

  if (event.kind === "hook-signal") return badgeForHookSignal(event);
  if (event.kind === "loop-lifecycle") return badgeForLoopLifecycle(event);

  return null;
}

function badgeForHookSignal(event: HookSignalEvent): TabIndicatorBadge | null {
  if (event.signal.name !== "post-tool-failure") return null;
  return {
    label: "tool-failed",
    tone: "agent-hook",
    title: "Agent hook: post-tool-failure",
  };
}

function badgeForLoopLifecycle(event: LoopLifecycleEvent): TabIndicatorBadge | null {
  switch (event.phase) {
    case "failed":
      return loopBadge("loop:failed", event);
    case "completed":
      return loopBadge("loop:done", event);
    case "blocked-on-approval":
    case "progress-milestone":
    case "started":
    case "iterating":
      return null;
  }
}

function loopBadge(label: string, event: LoopLifecycleEvent): TabIndicatorBadge {
  const agent = event.agent ? ` (${event.agent})` : "";
  return {
    label,
    tone: "charminal",
    title: `Loop lifecycle: ${event.phase}${agent}`,
  };
}

function targetSessionIdForEvent(event: DispatchEvent, state: SessionTabState): SessionId {
  const fromPayload = payloadSessionId(event);
  if (fromPayload !== null) return fromPayload;
  if (event.kind === "hook-signal" || event.kind === "loop-lifecycle") return state.mainSessionId;
  return state.activeSessionId ?? state.mainSessionId;
}

function payloadSessionId(event: DispatchEvent): SessionId | null {
  if (event.kind === "hook-signal") {
    return sessionIdFromUnknown(event.signal.payload);
  }
  if (event.kind === "loop-lifecycle") {
    return sessionIdFromUnknown(event.detail);
  }
  if ("payload" in event) {
    return sessionIdFromUnknown(event.payload);
  }
  return null;
}

function sessionIdFromUnknown(value: unknown): SessionId | null {
  const payload = value;
  if (typeof payload !== "object" || payload === null) return null;
  const sessionId = (payload as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : null;
}
