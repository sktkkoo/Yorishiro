import { describe, expect, it } from "vitest";
import { createAttentionRuntime } from "./attention-runtime";

describe("AttentionRuntime", () => {
  it("publishes resolved snapshots to subscribers", () => {
    const runtime = createAttentionRuntime();
    const snapshots: unknown[] = [];
    const sub = runtime.subscribe((snapshot) => snapshots.push(snapshot));

    runtime.setSourceTarget("focus", {
      kind: "terminal-region",
      source: "focus",
      rect: { x: 10, y: 20, width: 30, height: 40 },
      priority: 2,
      confidence: 0.8,
      timestamp: performance.now(),
    });

    expect(snapshots).toHaveLength(2);
    expect(runtime.getSnapshot().target?.kind).toBe("terminal-region");

    sub.dispose();
    runtime.setSourceTarget("focus", null);
    expect(snapshots).toHaveLength(2);
  });

  it("uses resolver priority across sources", () => {
    const runtime = createAttentionRuntime();
    const now = performance.now();

    runtime.setSourceTarget("focus", {
      kind: "terminal-region",
      source: "focus",
      rect: { x: 10, y: 20, width: 30, height: 40 },
      priority: 2,
      confidence: 1,
      timestamp: now,
    });
    runtime.setSourceTarget("cursor", {
      kind: "input-cursor",
      source: "cursor",
      rect: { x: 50, y: 60, width: 12, height: 20 },
      priority: 5,
      confidence: 1,
      timestamp: now,
    });

    expect(runtime.getSnapshot().target?.source).toBe("cursor");
  });
});
