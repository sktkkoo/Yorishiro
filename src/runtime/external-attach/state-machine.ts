export type ExternalAttachMode = "idle" | "auto-companion" | "manual-override";

export interface ExternalAttachState {
  readonly clientCount: number;
  readonly mode: ExternalAttachMode;
  readonly restorePending: boolean;
}

export type ExternalAttachSignal =
  | {
      readonly type: "clients-changed";
      readonly count: number;
      readonly activeUiId: string | null;
      readonly companionUiId: string;
    }
  | {
      readonly type: "active-ui-changed";
      readonly activeUiId: string | null;
      readonly companionUiId: string;
      readonly automatic: boolean;
    }
  | {
      readonly type: "restore-delay-elapsed";
      readonly activeUiId: string | null;
      readonly companionUiId: string;
    };

export type ExternalAttachCommand =
  | "enter-companion"
  | "schedule-restore"
  | "cancel-restore"
  | "restore-prior"
  | "clear-snapshot";

export interface ExternalAttachTransition {
  readonly state: ExternalAttachState;
  readonly commands: readonly ExternalAttachCommand[];
}

export const INITIAL_EXTERNAL_ATTACH_STATE: ExternalAttachState = {
  clientCount: 0,
  mode: "idle",
  restorePending: false,
};

function normalizedClientCount(count: number): number {
  return Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0;
}

/**
 * Pure edge-driven state machine for external terminal clients. The controller
 * executes the returned commands; all UI and timer effects stay outside this
 * function so reconnect and manual-override semantics are directly testable.
 */
export function transitionExternalAttach(
  state: ExternalAttachState,
  signal: ExternalAttachSignal,
): ExternalAttachTransition {
  if (signal.type === "active-ui-changed") {
    if (
      signal.automatic ||
      state.mode !== "auto-companion" ||
      signal.activeUiId === signal.companionUiId
    ) {
      return { state, commands: [] };
    }
    return {
      state: {
        ...state,
        mode: "manual-override",
        restorePending: false,
      },
      commands: state.restorePending ? ["cancel-restore", "clear-snapshot"] : ["clear-snapshot"],
    };
  }

  if (signal.type === "restore-delay-elapsed") {
    if (!state.restorePending || state.clientCount !== 0) {
      return { state, commands: [] };
    }
    if (state.mode === "auto-companion" && signal.activeUiId === signal.companionUiId) {
      return {
        state: { clientCount: 0, mode: "idle", restorePending: false },
        commands: ["restore-prior"],
      };
    }
    return {
      state: { clientCount: 0, mode: "idle", restorePending: false },
      commands: ["clear-snapshot"],
    };
  }

  const nextCount = normalizedClientCount(signal.count);
  const wasAttached = state.clientCount > 0;
  const isAttached = nextCount > 0;

  if (wasAttached === isAttached) {
    return { state: { ...state, clientCount: nextCount }, commands: [] };
  }

  if (isAttached) {
    if (state.mode === "auto-companion" && state.restorePending) {
      return {
        state: { ...state, clientCount: nextCount, restorePending: false },
        commands: ["cancel-restore"],
      };
    }
    if (state.mode === "idle" && signal.activeUiId !== signal.companionUiId) {
      return {
        state: { clientCount: nextCount, mode: "auto-companion", restorePending: false },
        commands: ["enter-companion"],
      };
    }
    return { state: { ...state, clientCount: nextCount }, commands: [] };
  }

  if (state.mode === "auto-companion") {
    return {
      state: { ...state, clientCount: 0, restorePending: true },
      commands: ["schedule-restore"],
    };
  }

  return {
    state: { clientCount: 0, mode: "idle", restorePending: false },
    commands: state.mode === "manual-override" ? ["clear-snapshot"] : [],
  };
}
