/**
 * Perception — PTY / hook / idle / loop event を観察し DispatchEvent として EventBus に供給する event source。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「六要素 > 知覚」+「認識の境界」
 * SDK surface: src/sdk/reaction.d.ts の DispatchEvent union
 *
 * Design:
 *   - Perception は Tauri API を直接 import しない（testability のため）
 *   - 外部（Terminal / App / MCP / pack）が onPtyOutput / onHookSignal / onUserInput / ingestLoopLifecycle を呼ぶ
 *   - 内部で idle detection timer を管理し、自律的に IdleEvent を生成する
 *   - 全 event は EventBus.dispatch() に流れる（PTY 出力も loop の構造化 stream も同格の観察源）
 */

import type {
  Cancellable,
  HookSignal,
  HookSignalEvent,
  IdleEvent,
  LoopLifecycleEvent,
  LoopPhase,
  PtyOutputEvent,
  ToolActivityEvent,
  UserInputEvent,
} from "@charminal/sdk";
import type { EventBus } from "../../runtime/event-bus";
import type { SubsystemLog } from "../dev-log";
import type { Time } from "../time";

const DEFAULT_IDLE_THRESHOLD_MS = 30_000;
const DEFAULT_IDLE_CHECK_INTERVAL_MS = 5_000;

export interface PerceptionDeps {
  readonly bus: EventBus;
  readonly time: Time;
  /** Idle detection threshold. Default 30s. */
  readonly idleThresholdMs?: number;
  /** Idle check interval. Default 5s. */
  readonly idleCheckIntervalMs?: number;
  /**
   * Optional dev-log adapter for generation-time self-observation.
   * See docs/philosophy/CHARMINAL.md「ログという細い回路（生成期の sibling）」.
   */
  readonly devLog?: SubsystemLog;
  /** user-prompt-submit 検知時に呼ばれる。Presence を full に復帰する。 */
  readonly onPresenceRestore?: () => void;
}

/**
 * Map hook-server event names to SDK HookSignal names.
 * The hook server uses short names; the SDK uses the full Claude Code hook lifecycle names.
 */
const mapHookEvent = (event: string): HookSignal["name"] | null => {
  switch (event) {
    case "prompt":
      return "user-prompt-submit";
    case "pre-tool-use":
      return "pre-tool-use";
    case "post-tool-use":
      return "post-tool-use";
    case "post-tool-failure":
      return "post-tool-failure";
    case "stop":
      return "stop";
    default:
      return null;
  }
};

/**
 * Infer tool activity from pre-tool-use hook data.
 * Maps Claude Code tool names to reading/writing/running categories.
 */
const inferToolActivity = (toolName: string): ToolActivityEvent["activity"] => {
  const lower = toolName.toLowerCase();
  if (
    lower.includes("read") ||
    lower.includes("glob") ||
    lower.includes("grep") ||
    lower.includes("search")
  ) {
    return "reading";
  }
  if (lower.includes("write") || lower.includes("edit")) {
    return "writing";
  }
  if (lower.includes("bash") || lower.includes("exec") || lower.includes("run")) {
    return "running";
  }
  return "reading";
};

export class Perception {
  private readonly bus: EventBus;
  private readonly time: Time;
  private readonly idleThresholdMs: number;
  private readonly devLog?: SubsystemLog;
  private readonly onPresenceRestore?: () => void;
  private lastActivityAt: number;
  private idleTimer: Cancellable | null = null;
  private disposed = false;

  constructor(deps: PerceptionDeps) {
    this.bus = deps.bus;
    this.time = deps.time;
    this.idleThresholdMs = deps.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.devLog = deps.devLog;
    this.onPresenceRestore = deps.onPresenceRestore;
    this.lastActivityAt = this.time.now();

    const interval = deps.idleCheckIntervalMs ?? DEFAULT_IDLE_CHECK_INTERVAL_MS;
    this.idleTimer = this.time.every(interval, () => {
      this.checkIdle();
    });
  }

  /** Called by Terminal when decoded PTY text arrives. */
  onPtyOutput(text: string): void {
    if (this.disposed) return;
    this.lastActivityAt = this.time.now();
    const event: PtyOutputEvent = {
      kind: "pty-output",
      text,
      timestamp: this.time.now(),
    };
    this.bus.dispatch(event);
  }

  /**
   * Called when a hook-signal Tauri event arrives.
   * Accepts the raw JSON string from the hook server.
   */
  onHookSignal(raw: string): void {
    this.devLog?.write({
      phase: "hook",
      note: raw.slice(0, 60),
      data: { disposed: this.disposed },
    });
    if (this.disposed) return;
    this.lastActivityAt = this.time.now();

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const eventName = parsed.event as string | undefined;
    if (!eventName) return;

    const signalName = mapHookEvent(eventName);
    if (!signalName) return;

    const signal: HookSignal = {
      name: signalName,
      payload: parsed,
    };
    const event: HookSignalEvent = {
      kind: "hook-signal",
      signal,
      timestamp: this.time.now(),
    };
    this.bus.dispatch(event);

    // Presence restore: user が prompt を送信したら full に復帰
    if (signalName === "user-prompt-submit") {
      this.onPresenceRestore?.();
    }

    // Emit ToolActivityEvent for pre-tool-use
    if (eventName === "pre-tool-use" && typeof parsed.tool_name === "string") {
      const activity = inferToolActivity(parsed.tool_name);
      const toolEvent: ToolActivityEvent = {
        kind: "tool-activity",
        activity,
        timestamp: this.time.now(),
      };
      this.bus.dispatch(toolEvent);
    }

    // Emit ToolActivityEvent "none" on stop
    if (eventName === "stop") {
      const toolEvent: ToolActivityEvent = {
        kind: "tool-activity",
        activity: "none",
        timestamp: this.time.now(),
      };
      this.bus.dispatch(toolEvent);
    }
  }

  /** Called by Terminal on user keystroke. */
  onUserInput(text: string): void {
    if (this.disposed) return;
    this.lastActivityAt = this.time.now();
    const event: UserInputEvent = {
      kind: "user-input",
      text,
      timestamp: this.time.now(),
    };
    this.bus.dispatch(event);
  }

  /**
   * 自律 agent loop の lifecycle phase を観察 stream に ingest する。
   *
   * MCP `loop_announce` handler（住人 AI 由来）と amenity の `ctx.loop.announce`
   * （pack 由来）が共通で呼ぶ単一の ingest 経路。PTY 出力と同格の観察源として
   * `LoopLifecycleEvent` を EventBus に流す（custom trigger が `kind ===
   * "loop-lifecycle"` で match できる）。詳細: docs/decisions/loop-presence-layer.md
   *
   * `agent` は host が stamp した観察主体（MCP 由来は terminalAgent id、pack 由来は
   * null）。caller が詐称できないよう、呼び出し側で確定した値を受け取るだけ。
   *
   * NOTE: loop event は **user activity ではない**——`lastActivityAt` を更新しない。
   * 自律ループ進行中こそ user は離席している（away mode）ので、loop の進行で
   * idle 反応を抑制すべきではない。docs/decisions/autonomy-without-disruption.md
   */
  ingestLoopLifecycle(phase: LoopPhase, agent: string | null, detail?: unknown): void {
    if (this.disposed) return;
    const event: LoopLifecycleEvent = {
      kind: "loop-lifecycle",
      phase,
      agent,
      detail,
      timestamp: this.time.now(),
    };
    this.bus.dispatch(event);
  }

  dispose(): void {
    this.disposed = true;
    this.idleTimer?.cancel();
    this.idleTimer = null;
  }

  // ─── internals ────────────────────────────────────────────────

  private checkIdle(): void {
    if (this.disposed) return;
    const now = this.time.now();
    const elapsed = now - this.lastActivityAt;
    if (elapsed >= this.idleThresholdMs) {
      const event: IdleEvent = {
        kind: "idle",
        durationMs: elapsed,
        timestamp: now,
      };
      this.bus.dispatch(event);
    }
  }
}
