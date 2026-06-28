import { describe, expect, it } from "vitest";
import type { SessionActivity, SessionLifecycle } from "../sessions/types";
import {
  deriveSessionStatusBadge,
  isNoteworthyBadge,
  type SessionStatus,
  SessionStatusStore,
} from "./session-status-store";

const status = (
  overrides: Partial<SessionStatus> & {
    lifecycle?: SessionLifecycle;
    activity?: SessionActivity;
  } = {},
): SessionStatus => ({
  sessionId: "s1",
  lifecycle: "running",
  activity: "idle",
  exitCode: null,
  attention: null,
  lastActivityAt: 1,
  unread: false,
  ...overrides,
});

describe("deriveSessionStatusBadge", () => {
  it("exited state has priority over activity", () => {
    expect(
      deriveSessionStatusBadge(
        status({ lifecycle: "exited", activity: "awaiting-input", exitCode: 0 }),
      ),
    ).toBe("exited-ok");
    expect(deriveSessionStatusBadge(status({ lifecycle: "exited", exitCode: 2 }))).toBe(
      "exited-fail",
    );
    expect(deriveSessionStatusBadge(status({ lifecycle: "exited", exitCode: null }))).toBe(
      "exited-unknown",
    );
  });

  it("prioritizes awaiting-input over running and starting", () => {
    expect(deriveSessionStatusBadge(status({ activity: "awaiting-input" }))).toBe("awaiting-input");
    expect(
      deriveSessionStatusBadge(status({ lifecycle: "starting", activity: "awaiting-input" })),
    ).toBe("awaiting-input");
  });

  it("maps running-command / starting / idle", () => {
    expect(deriveSessionStatusBadge(status({ activity: "running-command" }))).toBe("running");
    expect(deriveSessionStatusBadge(status({ lifecycle: "starting" }))).toBe("starting");
    expect(deriveSessionStatusBadge(status())).toBe("idle");
  });

  it("marks only user-attention badges as noteworthy", () => {
    expect(isNoteworthyBadge("awaiting-input")).toBe(true);
    expect(isNoteworthyBadge("exited-fail")).toBe(true);
    expect(isNoteworthyBadge("running")).toBe(false);
    expect(isNoteworthyBadge("exited-ok")).toBe(false);
  });
});

describe("SessionStatusStore", () => {
  const createStore = () => {
    let now = 100;
    const store = new SessionStatusStore({ now: () => now });
    return {
      store,
      tick: (next: number) => {
        now = next;
      },
    };
  };

  it("registers sessions with default starting status", () => {
    const { store } = createStore();
    let notifyCount = 0;
    store.subscribe(() => notifyCount++);

    store.register("default-session");

    expect(store.get("default-session")).toEqual({
      sessionId: "default-session",
      lifecycle: "starting",
      activity: "idle",
      exitCode: null,
      attention: null,
      lastActivityAt: 100,
      unread: false,
    });
    expect(notifyCount).toBe(1);
  });

  it("does not notify on duplicate register", () => {
    const { store } = createStore();
    let notifyCount = 0;
    store.subscribe(() => notifyCount++);

    store.register("s1");
    store.register("s1");

    expect(notifyCount).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it("updates lifecycle and activity with timestamps", () => {
    const { store, tick } = createStore();

    store.register("s1");
    tick(200);
    store.setLifecycle("s1", "running");
    tick(300);
    store.setActivity("s1", "running-command");

    expect(store.get("s1")).toMatchObject({
      lifecycle: "running",
      activity: "running-command",
      lastActivityAt: 300,
    });
  });

  it("creates a status when lifecycle is set before explicit register", () => {
    const { store } = createStore();
    let notifyCount = 0;
    store.subscribe(() => notifyCount++);

    store.setLifecycle("late-session", "starting");

    expect(store.get("late-session")?.lifecycle).toBe("starting");
    expect(notifyCount).toBe(1);
  });

  it("sets unread only for non-active session output and clears it on active", () => {
    const { store, tick } = createStore();

    store.markActive("s1");
    tick(150);
    store.markOutput("s1");
    tick(200);
    store.markOutput("s2");

    expect(store.get("s1")?.unread).toBe(false);
    expect(store.get("s1")?.lifecycle).toBe("running");
    expect(store.get("s2")?.unread).toBe(true);
    expect(store.get("s2")?.lifecycle).toBe("running");
    expect(store.get("s2")?.lastActivityAt).toBe(200);

    store.markActive("s2");

    expect(store.get("s2")?.unread).toBe(false);
    expect(store.getActiveSessionId()).toBe("s2");
  });

  it("does not notify when PTY output only advances lastActivityAt", () => {
    const { store, tick } = createStore();
    let notifyCount = 0;
    store.subscribe(() => notifyCount++);
    store.markActive("s1");

    tick(200);
    store.markOutput("s1");
    expect(store.get("s1")).toMatchObject({
      lifecycle: "running",
      unread: false,
      lastActivityAt: 200,
    });
    const afterFirstOutput = notifyCount;

    tick(300);
    store.markOutput("s1");

    expect(store.get("s1")?.lastActivityAt).toBe(300);
    expect(notifyCount).toBe(afterFirstOutput);
  });

  it("records terminal-native attention requests as awaiting-input", () => {
    const { store, tick } = createStore();
    store.markActive("s1");

    tick(250);
    store.markAttentionRequest("s2", {
      title: "Claude",
      body: "Permission needed to run Bash(ls)",
    });

    expect(store.get("s2")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Claude",
        body: "Permission needed to run Bash(ls)",
        receivedAt: 250,
      },
      unread: true,
      lastActivityAt: 250,
    });
    const got = store.get("s2");
    expect(got).not.toBeNull();
    if (got === null) return;
    expect(deriveSessionStatusBadge(got)).toBe("awaiting-input");
  });

  it("ignores empty attention requests", () => {
    const { store } = createStore();
    store.register("s1");
    let notifyCount = 0;
    store.subscribe(() => notifyCount++);

    store.markAttentionRequest("s1", { title: "Agent", body: "  " });

    expect(store.get("s1")?.attention).toBeNull();
    expect(notifyCount).toBe(0);
  });

  it("clears stale exit code when lifecycle starts again", () => {
    const { store } = createStore();
    store.recordExit("s1", 1);

    store.setLifecycle("s1", "starting");

    expect(store.get("s1")).toMatchObject({
      lifecycle: "starting",
      activity: "idle",
      exitCode: null,
    });
  });

  it("treats output after an exit as a running replacement session", () => {
    const { store } = createStore();
    store.recordExit("s1", 1);

    store.markOutput("s1");

    expect(store.get("s1")).toMatchObject({
      lifecycle: "running",
      exitCode: null,
    });
  });

  it("records exits as idle exited statuses with exit code", () => {
    const { store } = createStore();
    store.setActivity("s1", "running-command");

    store.recordExit("s1", 42);

    expect(store.get("s1")).toMatchObject({
      lifecycle: "exited",
      activity: "idle",
      exitCode: 42,
    });
    const got = store.get("s1");
    expect(got).not.toBeNull();
    if (got === null) return;
    expect(deriveSessionStatusBadge(got)).toBe("exited-fail");
  });

  it("removes session status and clears active when removing active session", () => {
    const { store } = createStore();
    store.markActive("s1");
    store.register("s2");

    store.remove("s1");

    expect(store.get("s1")).toBeNull();
    expect(store.get("s2")).not.toBeNull();
    expect(store.getActiveSessionId()).toBeNull();
  });
});
