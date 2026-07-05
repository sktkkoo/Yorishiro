/**
 * Pomodoro Timer — bundled amenity pack.
 *
 * state machine: idle → work → short-break → work → ... → long-break → idle
 *
 * フェーズ切替時に synthetic event を emit し、persona reflex が
 * voice や expression で反応する。terminal opacity は activate 時に
 * 注入される setTerminalOpacity + tweenManager で直接制御する。
 */

import type {
  AmenityContext,
  AmenityHandle,
  AmenityPackDefinition,
  Cancellable,
} from "@yorishiro/sdk";

// ─── Types ───────────────────────────────────────────────

type Phase = "idle" | "work" | "short-break" | "long-break";

interface PomodoroConfig {
  readonly workMs: number;
  readonly shortBreakMs: number;
  readonly longBreakMs: number;
  readonly rounds: number;
}

interface PomodoroState {
  phase: Phase;
  round: number;
  config: PomodoroConfig;
  phaseStartedAt: number;
  phaseDurationMs: number;
}

const DEFAULT_CONFIG: PomodoroConfig = {
  workMs: 25 * 60 * 1000,
  shortBreakMs: 5 * 60 * 1000,
  longBreakMs: 15 * 60 * 1000,
  rounds: 4,
};

// ─── Timer ───────────────────────────────────────────────

interface TerminalDimControl {
  dim(durationMs: number): void;
  restore(durationMs: number): void;
}

class PomodoroTimer {
  private state: PomodoroState | null = null;
  private phaseTimer: Cancellable | null = null;

  constructor(
    private readonly ctx: AmenityContext,
    private readonly terminalDim: TerminalDimControl,
  ) {}

  start(params: unknown): { config: PomodoroConfig } {
    if (this.state !== null && this.state.phase !== "idle") {
      this.cancelInternal();
    }

    const config = this.parseConfig(params);
    this.state = {
      phase: "idle",
      round: 0,
      config,
      phaseStartedAt: 0,
      phaseDurationMs: 0,
    };

    this.ctx.emitEvent("pomodoro:started", {
      workMs: config.workMs,
      shortBreakMs: config.shortBreakMs,
      longBreakMs: config.longBreakMs,
      rounds: config.rounds,
    });

    this.enterWork();
    return { config };
  }

  stop(): { cancelled: boolean; phase: Phase; round: number } {
    if (this.state === null || this.state.phase === "idle") {
      return { cancelled: false, phase: "idle", round: 0 };
    }
    const { phase, round } = this.state;
    this.cancelInternal();
    return { cancelled: true, phase, round };
  }

  status(): {
    phase: Phase;
    round: number;
    totalRounds: number;
    remainingMs: number;
    config: PomodoroConfig;
  } {
    if (this.state === null || this.state.phase === "idle") {
      return {
        phase: "idle",
        round: 0,
        totalRounds: 0,
        remainingMs: 0,
        config: DEFAULT_CONFIG,
      };
    }
    const elapsed = this.ctx.time.now() - this.state.phaseStartedAt;
    const remainingMs = Math.max(0, this.state.phaseDurationMs - elapsed);
    return {
      phase: this.state.phase,
      round: this.state.round,
      totalRounds: this.state.config.rounds,
      remainingMs,
      config: this.state.config,
    };
  }

  dispose(): void {
    if (this.state !== null && this.state.phase !== "idle") {
      this.cancelInternal();
    }
  }

  // ─── Internal ──────────────────────────────────────────

  private enterWork(): void {
    if (this.state === null) return;
    this.state.round++;
    this.state.phase = "work";
    this.state.phaseStartedAt = this.ctx.time.now();
    this.state.phaseDurationMs = this.state.config.workMs;

    this.terminalDim.restore(1000);

    this.ctx.emitEvent("pomodoro:work-started", {
      round: this.state.round,
      totalRounds: this.state.config.rounds,
    });

    this.phaseTimer = this.ctx.time.schedule(this.state.config.workMs, () => {
      this.enterBreak();
    });
  }

  private enterBreak(): void {
    if (this.state === null) return;
    const isLastRound = this.state.round >= this.state.config.rounds;
    const kind = isLastRound ? "long" : "short";
    const durationMs = isLastRound ? this.state.config.longBreakMs : this.state.config.shortBreakMs;

    this.state.phase = isLastRound ? "long-break" : "short-break";
    this.state.phaseStartedAt = this.ctx.time.now();
    this.state.phaseDurationMs = durationMs;

    this.terminalDim.dim(3000);

    this.ctx.emitEvent("pomodoro:break-started", {
      kind,
      round: this.state.round,
      durationMs,
    });

    this.phaseTimer = this.ctx.time.schedule(durationMs, () => {
      if (isLastRound) {
        this.complete();
      } else {
        this.enterWork();
      }
    });
  }

  private complete(): void {
    if (this.state === null) return;
    const rounds = this.state.round;
    this.terminalDim.restore(1000);
    this.ctx.emitEvent("pomodoro:session-completed", { rounds });
    this.state.phase = "idle";
    this.state.round = 0;
    this.phaseTimer = null;
  }

  private cancelInternal(): void {
    if (this.state === null) return;
    const { phase, round } = this.state;
    this.phaseTimer?.cancel();
    this.phaseTimer = null;
    this.terminalDim.restore(1000);
    this.ctx.emitEvent("pomodoro:cancelled", { phase, round });
    this.state.phase = "idle";
    this.state.round = 0;
  }

  private parseConfig(params: unknown): PomodoroConfig {
    if (params === null || typeof params !== "object") return DEFAULT_CONFIG;
    const p = params as Record<string, unknown>;
    return {
      workMs: typeof p.workMs === "number" ? p.workMs : DEFAULT_CONFIG.workMs,
      shortBreakMs:
        typeof p.shortBreakMs === "number" ? p.shortBreakMs : DEFAULT_CONFIG.shortBreakMs,
      longBreakMs: typeof p.longBreakMs === "number" ? p.longBreakMs : DEFAULT_CONFIG.longBreakMs,
      rounds: typeof p.rounds === "number" ? p.rounds : DEFAULT_CONFIG.rounds,
    };
  }
}

// ─── Pack Definition ─────────────────────────────────────

/**
 * activate に terminal opacity 制御用の deps を注入するための拡張 context。
 * bundled pack 固有——SDK の AmenityContext を拡張するが、SDK 型定義は汚さない。
 */
export interface PomodoroActivateContext extends AmenityContext {
  readonly setTerminalOpacity: (value: number) => void;
  readonly getTerminalOpacity: () => number;
}

export function createPomodoroAmenity(ctx: PomodoroActivateContext): AmenityHandle {
  const terminalDim: TerminalDimControl = {
    dim(durationMs) {
      ctx.tween.start("pomodoro:terminal-opacity", 0.2, durationMs, ctx.setTerminalOpacity, {
        from: ctx.getTerminalOpacity(),
      });
    },
    restore(durationMs) {
      ctx.tween.start("pomodoro:terminal-opacity", 1, durationMs, ctx.setTerminalOpacity, {
        from: ctx.getTerminalOpacity(),
      });
    },
  };

  const timer = new PomodoroTimer(ctx, terminalDim);

  return {
    tools: {
      pomodoro_start: async (params) => timer.start(params),
      pomodoro_stop: async () => timer.stop(),
      pomodoro_status: async () => timer.status(),
    },
    dispose: () => timer.dispose(),
  };
}

export default {
  id: "pomodoro",
  name: "Pomodoro Timer",
  toolMeta: [
    {
      name: "pomodoro_start",
      description: "Start a pomodoro session with configurable work/break durations",
      parameters: {
        workMs: { type: "number", description: "Work phase duration in ms (default 25min)" },
        shortBreakMs: { type: "number", description: "Short break duration in ms (default 5min)" },
        longBreakMs: { type: "number", description: "Long break duration in ms (default 15min)" },
        rounds: { type: "number", description: "Number of rounds (default 4)" },
      },
    },
    {
      name: "pomodoro_stop",
      description: "Stop the current pomodoro session",
    },
    {
      name: "pomodoro_status",
      description: "Get current pomodoro status (phase, round, remaining time)",
    },
  ],
  activate: async (ctx: AmenityContext) => {
    return createPomodoroAmenity(ctx as PomodoroActivateContext);
  },
} satisfies AmenityPackDefinition;
