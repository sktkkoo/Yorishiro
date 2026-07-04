import { describe, expect, it } from "vitest";
import type { SessionStatus } from "../session-status/session-status-store";
import {
  SESSION_ATTENTION_PRODUCER,
  startSessionAttentionProducer,
} from "./session-attention-producer";
import { createWorkspaceAttentionStore } from "./workspace-attention-store";

function sessionStatus(override: Partial<SessionStatus> = {}): SessionStatus {
  return {
    sessionId: "session-1",
    lifecycle: "running",
    activity: "awaiting-input",
    exitCode: null,
    attention: {
      title: "Permission needed",
      body: "Allow file write?",
      receivedAt: 1000,
      source: "hook",
    },
    lastActivityAt: 1000,
    unread: false,
    ...override,
  };
}

function createSessionStatusFake(initial: SessionStatus[] = []): {
  readonly sessionStatus: {
    subscribe: (listener: () => void) => () => void;
    list: () => ReadonlyArray<SessionStatus>;
  };
  readonly set: (next: SessionStatus[]) => void;
} {
  let statuses = initial;
  let listener: (() => void) | null = null;
  return {
    sessionStatus: {
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = null;
        };
      },
      list: () => statuses,
    },
    set: (next) => {
      statuses = next;
      listener?.();
    },
  };
}

describe("session attention producer", () => {
  it("awaiting-input + attention の session を active item にする", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createSessionStatusFake([sessionStatus()]);

    startSessionAttentionProducer({ store, sessionStatus: fake.sessionStatus });

    expect(store.getActiveItems()).toHaveLength(1);
    expect(store.getActiveItems()[0]).toMatchObject({
      sessionId: "session-1",
      type: "awaiting-approval",
      severity: "medium",
      producer: SESSION_ATTENTION_PRODUCER,
      producerKey: "session-attention:session-1",
      locus: { kind: "session", sessionId: "session-1" },
      detail: {
        receivedAt: 1000,
        title: "Permission needed",
        body: "Allow file write?",
        source: "hook",
      },
    });
  });

  it("attention が null に戻ったら resolve する", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createSessionStatusFake([sessionStatus()]);
    startSessionAttentionProducer({ store, sessionStatus: fake.sessionStatus });
    expect(store.getActiveItems()).toHaveLength(1);

    fake.set([sessionStatus({ activity: "idle", attention: null })]);

    expect(store.getActiveItems()).toHaveLength(0);
  });

  it("session が消えたら resolve する", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createSessionStatusFake([sessionStatus()]);
    startSessionAttentionProducer({ store, sessionStatus: fake.sessionStatus });
    expect(store.getActiveItems()).toHaveLength(1);

    fake.set([]);

    expect(store.getActiveItems()).toHaveLength(0);
  });

  it("非 active な background session でも item が立つ", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createSessionStatusFake([sessionStatus({ sessionId: "session-2", unread: true })]);

    startSessionAttentionProducer({ store, sessionStatus: fake.sessionStatus });

    expect(store.getActiveItems()).toHaveLength(1);
    expect(store.getActiveItems()[0]?.sessionId).toBe("session-2");
  });

  it("他 session の item には干渉しない", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createSessionStatusFake([
      sessionStatus({ sessionId: "session-1" }),
      sessionStatus({ sessionId: "session-2", activity: "idle", attention: null }),
    ]);
    startSessionAttentionProducer({ store, sessionStatus: fake.sessionStatus });
    expect(store.getActiveItems().map((item) => item.sessionId)).toEqual(["session-1"]);

    fake.set([
      sessionStatus({ sessionId: "session-1" }),
      sessionStatus({ sessionId: "session-2", activity: "idle", attention: null }),
    ]);

    expect(store.getActiveItems().map((item) => item.sessionId)).toEqual(["session-1"]);
  });

  it("同一 session で attention の identity が変わったら detail を更新する（item は差し替えない）", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createSessionStatusFake([
      sessionStatus({
        attention: { title: null, body: "A", receivedAt: 1000, source: "hook" },
      }),
    ]);
    startSessionAttentionProducer({ store, sessionStatus: fake.sessionStatus });
    const firstId = store.getActiveItems()[0]?.id;

    fake.set([
      sessionStatus({
        attention: { title: null, body: "B", receivedAt: 2000, source: "hook" },
      }),
    ]);

    expect(store.getActiveItems()).toHaveLength(1);
    expect(store.getActiveItems()[0]?.id).toBe(firstId);
    expect(store.getActiveItems()[0]?.detail).toMatchObject({ receivedAt: 2000, body: "B" });
  });

  it("dispose すると subscribe を解除し、以後の変化を反映しない", () => {
    const store = createWorkspaceAttentionStore();
    const fake = createSessionStatusFake([sessionStatus()]);
    const disposable = startSessionAttentionProducer({ store, sessionStatus: fake.sessionStatus });

    disposable.dispose();
    fake.set([sessionStatus({ activity: "idle", attention: null })]);

    expect(store.getActiveItems()).toHaveLength(1);
  });
});
