import { describe, expect, it } from "vitest";
import type { SessionActivity, SessionLifecycle } from "../sessions/types";
import {
  deriveSessionStatusBadge,
  isAttentionClearingInput,
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

  it("classifies only non-escape input as attention-clearing", () => {
    expect(isAttentionClearingInput("y")).toBe(true);
    expect(isAttentionClearingInput("\r")).toBe(true);
    expect(isAttentionClearingInput("\n")).toBe(true);

    // 矢印キー・マウス報告・focus reporting は ESC 始まりなので解除しない。
    expect(isAttentionClearingInput("\x1b[A")).toBe(false);
    expect(isAttentionClearingInput("\x1b[<0;10;10M")).toBe(false);
    expect(isAttentionClearingInput("\x1b[I")).toBe(false);
    expect(isAttentionClearingInput("")).toBe(false);
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
      activity: "running-command",
      unread: false,
      lastActivityAt: 200,
    });
    const afterFirstOutput = notifyCount;

    tick(300);
    store.markOutput("s1");

    expect(store.get("s1")?.lastActivityAt).toBe(300);
    expect(notifyCount).toBe(afterFirstOutput);
  });

  it("settles transient output running state back to idle", () => {
    const { store, tick } = createStore();
    store.markOutput("s1");

    tick(400);
    store.settleOutput("s1");

    expect(store.get("s1")).toMatchObject({
      lifecycle: "running",
      activity: "idle",
      lastActivityAt: 400,
    });
  });

  it("settleOutput does not clear awaiting-input attention", () => {
    const { store } = createStore();
    store.markOutput("s1");
    store.markAttentionRequest("s1", { title: "Claude", body: "Permission needed" });

    store.settleOutput("s1");

    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Claude",
        body: "Permission needed",
      },
    });
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
        source: "osc",
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

  it("keeps awaiting-input sticky through ongoing pty output", () => {
    const { store } = createStore();
    store.markActive("other");
    store.markAttentionRequest("s2", { title: "Claude", body: "Permission needed" });

    // 許可待ち中も agent の TUI 再描画で出力が来るが、許可待ちは消えない。
    store.markOutput("s2");
    store.markOutput("s2");

    expect(store.get("s2")).toMatchObject({
      activity: "awaiting-input",
      attention: { title: "Claude", body: "Permission needed" },
    });
  });

  it("keeps awaiting-input on focus and clears it on user input", () => {
    const { store } = createStore();
    store.markActive("other");
    store.markAttentionRequest("s2", { title: "Claude", body: "Permission needed" });

    // focus（タブを見ただけ）では許可待ちは消えない — まだ承認していない。
    store.markActive("s2");
    expect(store.get("s2")).toMatchObject({
      activity: "awaiting-input",
      attention: { title: "Claude", body: "Permission needed" },
      unread: false,
    });

    // 実際に応答した（ユーザー入力）ら解除する。
    store.clearAttention("s2");
    expect(store.get("s2")).toMatchObject({
      activity: "idle",
      attention: null,
    });
  });

  it("records screen attention idempotently", () => {
    const { store, tick } = createStore();
    store.register("s1");
    let notifyCount = 0;
    store.subscribe(() => notifyCount++);

    tick(100);
    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(100);
    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });

    expect(notifyCount).toBe(1);
    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Claude Code",
        body: "Allow command?",
        receivedAt: 100,
        source: "screen",
      },
    });
  });

  it("clears only screen-sourced attention when the prompt disappears from the screen", () => {
    const { store } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    store.clearScreenAttention("s1");
    expect(store.get("s1")).toMatchObject({ activity: "idle", attention: null });

    store.markAttentionRequest("s2", {
      title: "Claude Code",
      body: "Permission needed",
      source: "hook",
    });
    store.clearScreenAttention("s2");
    expect(store.get("s2")).toMatchObject({
      activity: "awaiting-input",
      attention: { source: "hook" },
    });
  });

  it("clears only loop-sourced attention when loop lifecycle moves on", () => {
    const { store } = createStore();

    store.markAttentionRequest("s1", {
      title: "Loop",
      body: "Blocked on approval",
      source: "loop",
    });
    store.clearLoopAttention("s1");
    expect(store.get("s1")).toMatchObject({ activity: "idle", attention: null });

    store.markAttentionRequest("s2", {
      title: "Claude Code",
      body: "Permission needed",
      source: "hook",
    });
    store.clearLoopAttention("s2");
    expect(store.get("s2")).toMatchObject({
      activity: "awaiting-input",
      attention: { source: "hook" },
    });
  });

  it("keeps screen attention authoritative over late hooks while prompt is visible", () => {
    const { store, tick } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(200);
    store.markAttentionRequest("s1", {
      title: "Claude Code",
      body: "Waiting for you",
      source: "hook",
    });

    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Claude Code",
        body: "Allow command?",
        receivedAt: 100,
        source: "screen",
      },
    });
  });

  it("suppresses late hook attention immediately after user cleared screen attention", () => {
    const { store, tick } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(100);
    store.clearAttention("s1");
    tick(100);
    store.markAttentionRequest("s1", {
      title: "Claude Code",
      body: "Allow command?",
      source: "hook",
    });

    expect(store.get("s1")).toMatchObject({ activity: "idle", attention: null });
  });

  it("suppresses stale screen attention immediately after user cleared the same prompt", () => {
    const { store, tick } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(100);
    store.clearAttention("s1");
    tick(100);
    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });

    expect(store.get("s1")).toMatchObject({ activity: "idle", attention: null });
  });

  it("allows the same screen attention after prompt disappearance was observed", () => {
    const { store, tick } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(100);
    store.clearAttention("s1");
    tick(100);
    store.clearScreenAttention("s1");
    tick(100);
    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });

    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Claude Code",
        body: "Allow command?",
        source: "screen",
      },
    });
  });

  it("allows a different screen attention after user cleared a previous prompt", () => {
    const { store, tick } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(100);
    store.clearAttention("s1");
    tick(100);
    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow edit?" });

    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Claude Code",
        body: "Allow edit?",
        source: "screen",
      },
    });
  });

  it("does not suppress loop lifecycle attention after user cleared screen attention", () => {
    const { store, tick } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(100);
    store.clearAttention("s1");
    tick(100);
    store.markAttentionRequest("s1", {
      title: "Loop",
      body: "Blocked on approval",
      source: "loop",
    });

    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Loop",
        body: "Blocked on approval",
        source: "loop",
      },
    });
  });

  it("allows loop lifecycle attention to supersede screen attention", () => {
    const { store, tick } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    tick(100);
    store.markAttentionRequest("s1", {
      title: "Loop",
      body: "Blocked on approval",
      source: "loop",
    });

    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Loop",
        body: "Blocked on approval",
        source: "loop",
      },
    });
  });

  it("does not clear loop attention from hook resolving signals", () => {
    const { store } = createStore();

    store.markAttentionRequest("s1", {
      title: "Loop",
      body: "Blocked on approval",
      source: "loop",
    });
    store.clearNonLoopAttention("s1");

    expect(store.get("s1")).toMatchObject({
      activity: "awaiting-input",
      attention: {
        title: "Loop",
        body: "Blocked on approval",
        source: "loop",
      },
    });
  });

  it("clears non-loop attention from hook resolving signals", () => {
    const { store } = createStore();

    store.markScreenAttentionRequest("s1", { title: "Claude Code", body: "Allow command?" });
    store.clearNonLoopAttention("s1");
    expect(store.get("s1")).toMatchObject({ activity: "idle", attention: null });

    store.markAttentionRequest("s2", {
      title: "Claude Code",
      body: "Permission needed",
      source: "hook",
    });
    store.clearNonLoopAttention("s2");
    expect(store.get("s2")).toMatchObject({ activity: "idle", attention: null });
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

  it("keeps the exited badge when trailing output arrives after exit", () => {
    const { store } = createStore();
    store.recordExit("s1", 1);

    // pty-exit と Channel output の順序次第で来る末尾出力で exit badge を消さない。
    store.markOutput("s1");

    expect(store.get("s1")).toMatchObject({
      lifecycle: "exited",
      exitCode: 1,
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
