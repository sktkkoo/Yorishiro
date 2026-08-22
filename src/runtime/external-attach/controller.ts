import {
  type ExternalAttachCommand,
  type ExternalAttachState,
  INITIAL_EXTERNAL_ATTACH_STATE,
  transitionExternalAttach,
} from "./state-machine";

export interface ExternalAttachControllerDeps<TPresentation> {
  readonly companionUiId: string;
  readonly getActiveUiId: () => string | null;
  readonly setActiveUi: (id: string | null) => void;
  readonly subscribeActiveUi: (listener: (id: string | null) => void) => () => void;
  readonly capturePresentation: () => TPresentation;
  readonly restorePresentation: (snapshot: TPresentation) => void;
  readonly refitPresentedTerminals: () => void;
  readonly debounceMs?: number;
  readonly setTimer?: (callback: () => void, delayMs: number) => number;
  readonly clearTimer?: (timer: number) => void;
}

export interface ExternalAttachController {
  readonly handleClientCount: (count: number) => void;
  readonly dispose: () => void;
  readonly getState: () => ExternalAttachState;
}

interface PriorPresentation<TPresentation> {
  readonly activeUiId: string | null;
  readonly presentation: TPresentation;
}

export function createExternalAttachController<TPresentation>(
  deps: ExternalAttachControllerDeps<TPresentation>,
): ExternalAttachController {
  const debounceMs = deps.debounceMs ?? 350;
  const setTimer = deps.setTimer ?? ((callback, delayMs) => window.setTimeout(callback, delayMs));
  const clearTimer = deps.clearTimer ?? ((timer) => window.clearTimeout(timer));

  let state = INITIAL_EXTERNAL_ATTACH_STATE;
  let prior: PriorPresentation<TPresentation> | null = null;
  let restoreTimer: number | null = null;
  let automaticUiChange = false;
  let disposed = false;

  const cancelRestoreTimer = (): void => {
    if (restoreTimer === null) return;
    clearTimer(restoreTimer);
    restoreTimer = null;
  };

  const setActiveUiAutomatically = (id: string | null): void => {
    automaticUiChange = true;
    try {
      deps.setActiveUi(id);
    } finally {
      automaticUiChange = false;
    }
  };

  const execute = (commands: readonly ExternalAttachCommand[]): void => {
    for (const command of commands) {
      switch (command) {
        case "enter-companion":
          prior = {
            activeUiId: deps.getActiveUiId(),
            presentation: deps.capturePresentation(),
          };
          setActiveUiAutomatically(deps.companionUiId);
          break;
        case "schedule-restore":
          cancelRestoreTimer();
          restoreTimer = setTimer(() => {
            restoreTimer = null;
            if (disposed) return;
            dispatch({
              type: "restore-delay-elapsed",
              activeUiId: deps.getActiveUiId(),
              companionUiId: deps.companionUiId,
            });
          }, debounceMs);
          break;
        case "cancel-restore":
          cancelRestoreTimer();
          break;
        case "restore-prior": {
          cancelRestoreTimer();
          const snapshot = prior;
          prior = null;
          if (snapshot === null) break;
          setActiveUiAutomatically(snapshot.activeUiId);
          deps.restorePresentation(snapshot.presentation);
          deps.refitPresentedTerminals();
          break;
        }
        case "clear-snapshot":
          prior = null;
          break;
      }
    }
  };

  const dispatch = (signal: Parameters<typeof transitionExternalAttach>[1]): void => {
    const transition = transitionExternalAttach(state, signal);
    state = transition.state;
    execute(transition.commands);
  };

  const unsubscribe = deps.subscribeActiveUi((activeUiId) => {
    if (disposed) return;
    dispatch({
      type: "active-ui-changed",
      activeUiId,
      companionUiId: deps.companionUiId,
      automatic: automaticUiChange,
    });
  });

  return {
    handleClientCount(count) {
      if (disposed) return;
      dispatch({
        type: "clients-changed",
        count,
        activeUiId: deps.getActiveUiId(),
        companionUiId: deps.companionUiId,
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      cancelRestoreTimer();
      unsubscribe();
      prior = null;
    },
    getState() {
      return state;
    },
  };
}
