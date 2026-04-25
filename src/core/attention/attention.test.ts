import { describe, expect, it } from "vitest";
import type { AttentionTarget } from ".";
import { resolveAttentionTarget } from "./attention-resolver";

function target(
  partial: Partial<AttentionTarget> & Pick<AttentionTarget, "kind" | "priority">,
): AttentionTarget {
  return {
    source: "test",
    rect: { x: 10, y: 20, width: 30, height: 40 },
    confidence: 1,
    timestamp: 1000,
    ...partial,
  };
}

describe("resolveAttentionTarget", () => {
  it("picks the highest priority fresh target", () => {
    const picked = resolveAttentionTarget(
      [
        target({ kind: "terminal-region", priority: 2 }),
        target({ kind: "input-cursor", priority: 5 }),
      ],
      { now: 1200 },
    );

    expect(picked?.kind).toBe("input-cursor");
  });

  it("uses confidence as a tie breaker", () => {
    const picked = resolveAttentionTarget(
      [
        target({ kind: "terminal-region", priority: 2, confidence: 0.4 }),
        target({ kind: "mouse", priority: 2, confidence: 0.8 }),
      ],
      { now: 1200 },
    );

    expect(picked?.kind).toBe("mouse");
  });

  it("rejects stale and invalid targets", () => {
    const picked = resolveAttentionTarget(
      [
        target({ kind: "mouse", priority: 10, timestamp: 0 }),
        target({
          kind: "terminal-region",
          priority: 9,
          rect: { x: 0, y: 0, width: 0, height: 10 },
        }),
        target({ kind: "input-cursor", priority: 5 }),
      ],
      { now: 2000 },
    );

    expect(picked?.kind).toBe("input-cursor");
  });
});
