/**
 * Tool attention producer。
 *
 * tool-activity perception event と hook-signal event を listen し、
 * attention target を emit / clear する。
 *
 * - tool-activity (reading|writing|running) → "tool-activity" source を emit
 *   (priority=4 / kind: terminal-region / reason: tool-reading|tool-writing|tool-running)
 *   3 秒後に auto null clear (pulse 化)。連続 activity は timer 上書き
 * - tool-activity (none) → "tool-activity" source を即時 clear (pulse timer も cancel)
 * - hook-signal post-tool-failure → "tool-diagnostic" source を emit
 *   (priority=6 / kind: terminal-region / reason: diagnostic)
 * - hook-signal stop → "tool-activity" source を belt-and-suspenders で clear
 *
 * v1 App.tsx「Tool-activity → Body state wiring」useEffect の attention emit を
 * producer 層に切り出したもの。source key / priority / confidence は v1 と 1:1。
 *
 * subscribeToolActivity / subscribeHookSignal / getCurrentLineRect は inject。
 * App.tsx の adapter から EventBus + terminal-runtime を繋ぐ。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const SOURCE_ACTIVITY = "tool-activity";
const SOURCE_DIAGNOSTIC = "tool-diagnostic";
const PRIORITY_ACTIVITY = 4;
const PRIORITY_DIAGNOSTIC = 6;
const CONFIDENCE_ACTIVITY = 0.72;
const CONFIDENCE_DIAGNOSTIC = 0.8;
const EXPAND_PX = 6;
// tool 1 回ごとに 3 秒だけ pulse させる。Claude が連続して tool を呼ぶ間も
// 「常駐」ではなく「光が瞬く」体感に揃え、画面下に居座らないようにする。
const PULSE_MS = 3000;

interface HookSignalEvent {
  readonly name: string;
}

// adapter から渡される activity は string（EventBus の型は string ベース）のため
// producer 内部で narrowing する。
interface ToolActivityEvent {
  readonly activity: string;
  readonly timestamp: number;
}

interface StartOptions {
  readonly attention: AttentionRuntime;
  /** hook-signal イベントを購読するアダプター。App.tsx の EventBus adapter から注入。 */
  readonly subscribeHookSignal: (handler: (event: HookSignalEvent) => void) => Disposable;
  /** tool-activity perception event を購読するアダプター。App.tsx の EventBus adapter から注入。 */
  readonly subscribeToolActivity: (handler: (event: ToolActivityEvent) => void) => Disposable;
  /** 現在の terminal 最終行の rect を返す。v1 の getRecentOutputLineClientRect と等価。 */
  readonly getCurrentLineRect: () => { x: number; y: number; width: number; height: number } | null;
}

export function startToolAttentionProducer(opts: StartOptions): Disposable {
  const { attention, subscribeHookSignal, subscribeToolActivity, getCurrentLineRect } = opts;

  let activityActive = false;
  let pulseTimer: ReturnType<typeof setTimeout> | null = null;

  const cancelPulse = (): void => {
    if (pulseTimer !== null) {
      clearTimeout(pulseTimer);
      pulseTimer = null;
    }
  };

  const emitActivity = (activity: string, timestamp: number): void => {
    const rect = getCurrentLineRect();
    if (rect === null) return;
    attention.setSourceTarget(SOURCE_ACTIVITY, {
      kind: "terminal-region",
      source: SOURCE_ACTIVITY,
      rect: {
        x: rect.x - EXPAND_PX,
        y: rect.y - EXPAND_PX,
        width: rect.width + EXPAND_PX * 2,
        height: rect.height + EXPAND_PX * 2,
      },
      confidence: CONFIDENCE_ACTIVITY,
      priority: PRIORITY_ACTIVITY,
      timestamp,
      reason: `tool-${activity}`,
    });
    activityActive = true;
    // pulse 化: 3 秒で auto null clear。新しい activity 発火時は前の timer を上書き。
    cancelPulse();
    pulseTimer = setTimeout(() => {
      attention.setSourceTarget(SOURCE_ACTIVITY, null);
      activityActive = false;
      pulseTimer = null;
    }, PULSE_MS);
  };

  const clearActivity = (): void => {
    cancelPulse();
    if (activityActive) {
      attention.setSourceTarget(SOURCE_ACTIVITY, null);
      activityActive = false;
    }
  };

  const activitySub = subscribeToolActivity((event) => {
    if (event.activity === "none") {
      clearActivity();
    } else {
      emitActivity(event.activity, event.timestamp);
    }
  });

  const hookSub = subscribeHookSignal((event) => {
    if (event.name === "post-tool-failure") {
      const rect = getCurrentLineRect();
      if (rect === null) return;
      attention.setSourceTarget(SOURCE_DIAGNOSTIC, {
        kind: "terminal-region",
        source: SOURCE_DIAGNOSTIC,
        rect: {
          x: rect.x - EXPAND_PX,
          y: rect.y - EXPAND_PX,
          width: rect.width + EXPAND_PX * 2,
          height: rect.height + EXPAND_PX * 2,
        },
        confidence: CONFIDENCE_DIAGNOSTIC,
        priority: PRIORITY_DIAGNOSTIC,
        timestamp: performance.now(),
        reason: "diagnostic",
      });
    } else if (event.name === "stop") {
      // belt-and-suspenders: tool-activity none は perception から来るが
      // stop でも clear する（v1 同様）。
      clearActivity();
    }
  });

  return {
    dispose: () => {
      activitySub.dispose();
      hookSub.dispose();
      cancelPulse();
    },
  };
}
