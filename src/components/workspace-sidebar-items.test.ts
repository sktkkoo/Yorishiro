import { describe, expect, it } from "vitest";
import type {
  WorkspaceAttentionItem,
  WorkspaceAttentionItemType,
  WorkspaceAttentionSeverity,
} from "../runtime/workspace-attention";
import { toSidebarItems } from "./workspace-sidebar-items";

function attentionItem(override: Partial<WorkspaceAttentionItem> = {}): WorkspaceAttentionItem {
  const type: WorkspaceAttentionItemType = override.type ?? "run-failed";
  const severity: WorkspaceAttentionSeverity = override.severity ?? "high";
  return {
    id: "attn-1",
    sessionId: "session-1",
    locus: { kind: "session", sessionId: "session-1" },
    type,
    severity,
    state: "active",
    createdAt: 1000,
    updatedAt: 1000,
    producer: { kind: "host", id: "command-block" },
    producerKey: "command-block:session-1:1",
    detail: { command: "npm test", exitCode: 1, durationMs: 200, completedBy: "osc133" },
    ...override,
  };
}

describe("toSidebarItems", () => {
  it("active item を sidebar 表示 item に変換する", () => {
    const items = toSidebarItems([attentionItem()]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      id: "attn-1",
      type: "run-failed",
      severity: "high",
      sessionId: "session-1",
    });
  });

  it("type に応じた人間向けラベルを付ける", () => {
    const failed = toSidebarItems([attentionItem({ type: "run-failed" })])[0];
    const slow = toSidebarItems([
      attentionItem({ id: "attn-2", type: "run-slow-completed", severity: "medium" }),
    ])[0];
    const running = toSidebarItems([
      attentionItem({ id: "attn-3", type: "run-running-long", severity: "medium" }),
    ])[0];
    expect(failed.label).toBe("失敗");
    expect(slow.label).toBe("遅延完了");
    expect(running.label).toBe("実行中");
  });

  it("detail.command を表示用テキストに取り出す", () => {
    const item = toSidebarItems([attentionItem()])[0];
    expect(item.detailText).toBe("npm test");
  });

  it("detail が無い / command を持たないときは detailText を undefined にする", () => {
    const item = toSidebarItems([attentionItem({ detail: undefined })])[0];
    expect(item.detailText).toBeUndefined();
    const malformed = toSidebarItems([attentionItem({ detail: { foo: "bar" } })])[0];
    expect(malformed.detailText).toBeUndefined();
  });

  it("severity が高い順、同 severity では新しい順に並べる", () => {
    const result = toSidebarItems([
      attentionItem({ id: "low", severity: "low", createdAt: 100 }),
      attentionItem({ id: "high", severity: "high", createdAt: 50 }),
      attentionItem({ id: "medium-old", severity: "medium", createdAt: 10 }),
      attentionItem({ id: "medium-new", severity: "medium", createdAt: 80 }),
    ]);
    expect(result.map((entry) => entry.id)).toEqual(["high", "medium-new", "medium-old", "low"]);
  });

  it("active でない item は除外する（防御的）", () => {
    const result = toSidebarItems([
      attentionItem({ id: "active", state: "active" }),
      attentionItem({ id: "resolved", state: "resolved" }),
      attentionItem({ id: "snoozed", state: "snoozed" }),
    ]);
    expect(result.map((entry) => entry.id)).toEqual(["active"]);
  });

  it("空配列なら空配列を返す", () => {
    expect(toSidebarItems([])).toEqual([]);
  });
});
