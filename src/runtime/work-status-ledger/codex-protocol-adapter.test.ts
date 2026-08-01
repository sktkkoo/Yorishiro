import { describe, expect, it } from "vitest";
import {
  CodexWorkStatusProtocolAdapter,
  getCodexWorkStatusProtocolAdapter,
} from "./codex-protocol-adapter";
import { createWorkStatusLedgerStore } from "./work-status-ledger-store";

const userMessage = (text: string) => ({
  type: "userMessage",
  id: "user-1",
  content: [{ type: "text", text, text_elements: [] }],
});

describe("CodexWorkStatusProtocolAdapter", () => {
  it("projects a root turn through running and completion with a stable work id", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");

    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [userMessage("Create a sample file")] },
    });
    const running = ledger.getSnapshot().work[0];
    expect(running).toMatchObject({
      id: "work-1",
      summary: "Create a sample file",
      sessionId: "session-1",
      status: "running",
    });

    adapter.observeNotification("turn/completed", {
      threadId: "root",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    expect(ledger.get("work-1")?.status).toBe("completed");
  });

  it("waits for a user item when turn/started has no summary and ignores duplicates", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");
    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    expect(ledger.getSnapshot().work).toHaveLength(0);

    const event = { threadId: "root", turnId: "turn-1", item: userMessage("Run tests") };
    adapter.observeNotification("item/started", event);
    adapter.observeNotification("item/started", event);
    expect(ledger.getSnapshot().work).toHaveLength(1);
  });

  it("creates delegated work from the realtime handoff before its empty root turn", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");

    const handoff = {
      threadId: "root",
      item: {
        type: "handoff_request",
        handoff_id: "handoff-1",
        item_id: "item-1",
        input_transcript: "Create sample.md",
        active_transcript: [],
      },
    };
    adapter.observeNotification("thread/realtime/itemAdded", handoff);
    adapter.observeNotification("thread/realtime/itemAdded", handoff);
    expect(ledger.getSnapshot().work).toHaveLength(1);
    expect(ledger.get("work-1")).toMatchObject({
      summary: "Create sample.md",
      status: "running",
    });

    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });
    adapter.observeNotification("item/started", {
      threadId: "root",
      turnId: "turn-1",
      item: userMessage("<realtime_delegation>...</realtime_delegation>"),
    });
    expect(ledger.getSnapshot().work).toHaveLength(1);

    adapter.observeNotification("turn/completed", {
      threadId: "root",
      turn: { id: "turn-1", status: "completed", items: [] },
    });
    expect(ledger.get("work-1")?.status).toBe("completed");
  });

  it("pairs a realtime handoff that arrives after its empty root turn", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");
    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [] },
    });

    adapter.observeNotification("thread/realtime/itemAdded", {
      threadId: "root",
      item: {
        type: "handoff_request",
        handoff_id: "handoff-1",
        item_id: "item-1",
        input_transcript: "",
        active_transcript: [
          { role: "assistant", text: "What should I do?" },
          { role: "user", text: "Run the checks" },
        ],
      },
    });
    adapter.observeNotification("turn/completed", {
      threadId: "root",
      turn: { id: "turn-1", status: "failed", items: [] },
    });

    expect(ledger.get("work-1")).toMatchObject({
      summary: "Run the checks",
      status: "failed",
    });
  });

  it("treats a realtime handoff during an active root turn as steering", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");
    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [userMessage("Initial task")] },
    });

    adapter.observeNotification("thread/realtime/itemAdded", {
      threadId: "root",
      item: {
        type: "handoff_request",
        handoff_id: "handoff-steer",
        item_id: "item-steer",
        input_transcript: "Also check formatting",
        active_transcript: [],
      },
    });

    expect(ledger.getSnapshot().work).toHaveLength(1);
    expect(ledger.get("work-1")).toMatchObject({ summary: "Initial task", status: "running" });
  });

  it("mirrors approval hold and resolution without responding to the request", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");
    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [userMessage("Publish build")] },
    });
    adapter.observeServerRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "root", turnId: "turn-1", itemId: "exec-1" },
    });
    adapter.observeServerRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "root", turnId: "turn-1", itemId: "exec-1" },
    });
    expect(ledger.get("work-1")).toMatchObject({
      status: "approval-required",
      pendingApprovals: ["string:approval-1"],
    });

    adapter.observeNotification("serverRequest/resolved", {
      threadId: "root",
      requestId: "approval-1",
    });
    expect(ledger.get("work-1")?.status).toBe("running");
  });

  it("reuses correlation state and reconciles a completion missed while voice was stopped", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = getCodexWorkStatusProtocolAdapter(ledger, "session-1", "root");
    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [userMessage("Run checks")] },
    });

    const reconnected = getCodexWorkStatusProtocolAdapter(ledger, "session-1", "root");
    expect(reconnected).toBe(adapter);
    expect(
      reconnected.reconcileRootThread({
        id: "root",
        status: { type: "idle" },
        turns: [{ id: "turn-1", status: "completed", items: [] }],
      }),
    ).toEqual({ matchedTurns: 1, terminalTurns: 1, releasedApprovals: 0 });
    expect(ledger.get("work-1")?.status).toBe("completed");
  });

  it("reconciles an approval resolution missed while the root turn remains active", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = getCodexWorkStatusProtocolAdapter(ledger, "session-1", "root");
    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "turn-1", status: "inProgress", items: [userMessage("Publish build")] },
    });
    adapter.observeServerRequest({
      id: "approval-1",
      method: "item/commandExecution/requestApproval",
      params: { threadId: "root", turnId: "turn-1", itemId: "exec-1" },
    });

    expect(ledger.get("work-1")?.status).toBe("approval-required");
    expect(
      adapter.reconcileRootThread({
        id: "root",
        status: { type: "active", activeFlags: [] },
        turns: [{ id: "turn-1", status: "inProgress", items: [] }],
      }),
    ).toEqual({ matchedTurns: 1, terminalTurns: 0, releasedApprovals: 1 });
    expect(ledger.get("work-1")?.status).toBe("running");
  });

  it("associates subagent approvals with the originating root work", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");
    adapter.observeNotification("turn/started", {
      threadId: "root",
      turn: { id: "root-turn", status: "inProgress", items: [userMessage("Delegate review")] },
    });
    adapter.observeNotification("item/started", {
      threadId: "root",
      turnId: "root-turn",
      item: {
        type: "collabAgentToolCall",
        id: "spawn-1",
        receiverThreadIds: ["child"],
      },
    });
    adapter.observeNotification("turn/started", {
      threadId: "child",
      turn: { id: "child-turn", status: "inProgress", items: [] },
    });
    adapter.observeServerRequest({
      id: 7,
      method: "item/fileChange/requestApproval",
      params: { threadId: "child", turnId: "child-turn", itemId: "patch-1" },
    });
    expect(ledger.get("work-1")).toMatchObject({
      status: "approval-required",
      pendingApprovals: ["number:7"],
    });

    expect(adapter.pendingApprovalThreadIds()).toEqual(["child"]);
    expect(
      adapter.reconcileApprovalThread({
        id: "child",
        status: { type: "idle" },
      }),
    ).toBe(1);
    expect(ledger.get("work-1")?.status).toBe("running");
  });

  it("ignores unrelated threads and maps failed/interrupted terminal outcomes", () => {
    const ledger = createWorkStatusLedgerStore();
    const adapter = new CodexWorkStatusProtocolAdapter(ledger, "session-1");
    adapter.setRootThreadId("root");
    adapter.observeNotification("turn/started", {
      threadId: "other",
      turn: { id: "other-turn", status: "inProgress", items: [userMessage("Ignore me")] },
    });
    expect(ledger.getSnapshot().work).toHaveLength(0);

    for (const [index, status] of (["failed", "interrupted"] as const).entries()) {
      const turnId = `turn-${index}`;
      adapter.observeNotification("turn/started", {
        threadId: "root",
        turn: { id: turnId, status: "inProgress", items: [userMessage(`Task ${index}`)] },
      });
      adapter.observeNotification("turn/completed", {
        threadId: "root",
        turn: { id: turnId, status, items: [] },
      });
    }
    expect(ledger.getSnapshot().work.map((work) => work.status)).toEqual(["failed", "cancelled"]);
  });
});
