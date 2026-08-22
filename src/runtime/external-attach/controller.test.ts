import { describe, expect, it } from "vitest";
import { createExternalAttachController } from "./controller";

interface Harness {
  readonly controller: ReturnType<typeof createExternalAttachController<{ presence: string }>>;
  readonly calls: string[];
  readonly setUiManually: (id: string | null) => void;
  readonly runTimers: () => void;
  readonly pendingTimerCount: () => number;
  readonly listenerCount: () => number;
  readonly scheduledDelays: number[];
}

function createHarness(initialUi: string | null = "workspace"): Harness {
  let activeUi = initialUi;
  const listeners = new Set<(id: string | null) => void>();
  const calls: string[] = [];
  const timers = new Map<number, () => void>();
  const scheduledDelays: number[] = [];
  let nextTimer = 1;

  const notifyActiveUi = (id: string | null): void => {
    activeUi = id;
    for (const listener of [...listeners]) listener(id);
  };

  const controller = createExternalAttachController({
    companionUiId: "companion",
    getActiveUiId: () => activeUi,
    setActiveUi: (id) => {
      calls.push(`set-ui:${id ?? "null"}`);
      notifyActiveUi(id);
    },
    subscribeActiveUi: (listener) => {
      listeners.add(listener);
      listener(activeUi);
      return () => listeners.delete(listener);
    },
    capturePresentation: () => {
      calls.push("capture-presentation");
      return { presence: "closed" };
    },
    restorePresentation: (snapshot) => calls.push(`restore-presentation:${snapshot.presence}`),
    refitPresentedTerminals: () => calls.push("refit"),
    debounceMs: 350,
    setTimer: (callback, delayMs) => {
      const id = nextTimer++;
      scheduledDelays.push(delayMs);
      timers.set(id, callback);
      return id;
    },
    clearTimer: (id) => timers.delete(id),
  });

  return {
    controller,
    calls,
    setUiManually: notifyActiveUi,
    runTimers: () => {
      for (const [id, callback] of [...timers]) {
        timers.delete(id);
        callback();
      }
    },
    pendingTimerCount: () => timers.size,
    listenerCount: () => listeners.size,
    scheduledDelays,
  };
}

describe("external attach companion controller", () => {
  it("enters companion on 0 -> 1 and restores the prior UI on 1 -> 0", () => {
    const harness = createHarness("workspace");

    harness.controller.handleClientCount(1);
    expect(harness.calls).toEqual(["capture-presentation", "set-ui:companion"]);
    expect(harness.controller.getState().mode).toBe("auto-companion");

    harness.controller.handleClientCount(0);
    expect(harness.pendingTimerCount()).toBe(1);
    expect(harness.scheduledDelays).toEqual([350]);
    harness.runTimers();

    expect(harness.calls).toEqual([
      "capture-presentation",
      "set-ui:companion",
      "set-ui:workspace",
      "restore-presentation:closed",
      "refit",
    ]);
    expect(harness.controller.getState()).toEqual({
      clientCount: 0,
      mode: "idle",
      restorePending: false,
    });
  });

  it("does nothing when companion was already selected manually", () => {
    const harness = createHarness("companion");

    harness.controller.handleClientCount(1);
    harness.controller.handleClientCount(0);
    harness.runTimers();

    expect(harness.calls).toEqual([]);
    expect(harness.controller.getState().mode).toBe("idle");
  });

  it("cancels auto-restore after a manual UI override", () => {
    const harness = createHarness("workspace");

    harness.controller.handleClientCount(1);
    harness.setUiManually("theater");
    expect(harness.controller.getState().mode).toBe("manual-override");

    harness.controller.handleClientCount(0);
    harness.runTimers();

    expect(harness.calls).toEqual(["capture-presentation", "set-ui:companion"]);
    expect(harness.controller.getState().mode).toBe("idle");
  });

  it("ignores positive-count changes that do not cross an attach edge", () => {
    const harness = createHarness("workspace");

    harness.controller.handleClientCount(1);
    harness.controller.handleClientCount(2);
    harness.controller.handleClientCount(1);

    expect(harness.calls).toEqual(["capture-presentation", "set-ui:companion"]);
    expect(harness.pendingTimerCount()).toBe(0);
  });

  it("debounces detach so a reconnect keeps the existing auto companion", () => {
    const harness = createHarness("workspace");

    harness.controller.handleClientCount(1);
    harness.controller.handleClientCount(0);
    expect(harness.pendingTimerCount()).toBe(1);

    harness.controller.handleClientCount(1);
    expect(harness.pendingTimerCount()).toBe(0);
    harness.runTimers();
    expect(harness.calls).toEqual(["capture-presentation", "set-ui:companion"]);

    harness.controller.handleClientCount(0);
    harness.runTimers();
    expect(harness.calls.slice(-3)).toEqual([
      "set-ui:workspace",
      "restore-presentation:closed",
      "refit",
    ]);
  });

  it("teardown unsubscribes and cancels a pending restore", () => {
    const harness = createHarness("workspace");

    harness.controller.handleClientCount(1);
    harness.controller.handleClientCount(0);
    expect(harness.listenerCount()).toBe(1);
    expect(harness.pendingTimerCount()).toBe(1);

    harness.controller.dispose();
    expect(harness.listenerCount()).toBe(0);
    expect(harness.pendingTimerCount()).toBe(0);
    harness.runTimers();
    harness.setUiManually("theater");

    expect(harness.calls).toEqual(["capture-presentation", "set-ui:companion"]);
  });

  it("restores UI, then presentation, then refits", () => {
    const harness = createHarness("workspace");
    harness.controller.handleClientCount(1);
    harness.calls.length = 0;

    harness.controller.handleClientCount(0);
    harness.runTimers();

    expect(harness.calls).toEqual(["set-ui:workspace", "restore-presentation:closed", "refit"]);
  });

  it("ignores client events after teardown", () => {
    const harness = createHarness("workspace");
    harness.controller.dispose();

    harness.controller.handleClientCount(1);

    expect(harness.calls).toEqual([]);
  });
});
