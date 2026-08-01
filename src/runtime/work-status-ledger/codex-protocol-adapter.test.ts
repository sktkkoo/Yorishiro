import { describe, expect, it } from "vitest";
import { CodexWorkStatusProtocolAdapter } from "./codex-protocol-adapter";
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
