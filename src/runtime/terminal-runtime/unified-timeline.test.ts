import { describe, expect, it } from "vitest";
import { mergeRunTimeline } from "./unified-timeline";

describe("mergeRunTimeline", () => {
  it("command / agent-tool / loop の 3 種を startedAt 降順で 1 つの timeline に並べる", () => {
    const timeline = mergeRunTimeline({
      commandRuns: [
        {
          sessionId: "shell-1",
          id: 1,
          command: "npm test",
          status: "failed",
          startedAt: 1000,
          endedAt: 1100,
        },
      ],
      agentToolRuns: [
        {
          sessionId: "claude-1",
          id: 1,
          activity: "running",
          status: "completed",
          startedAt: 1200,
          endedAt: 1300,
        },
      ],
      loopRuns: [
        {
          sessionId: "claude-1",
          id: 1,
          phase: "completed",
          status: "completed",
          startedAt: 900,
          endedAt: 1400,
        },
      ],
    });
    // startedAt desc: agent-tool(1200) > command(1000) > loop(900)
    expect(timeline.map((e) => e.kind)).toEqual(["agent-tool", "command", "loop"]);
  });

  it("空入力は空 timeline", () => {
    expect(mergeRunTimeline({ commandRuns: [], agentToolRuns: [], loopRuns: [] })).toEqual([]);
  });

  it("各 entry が kind/sessionId/label/status/startedAt を持つ（primitive は分けたまま統合）", () => {
    const timeline = mergeRunTimeline({
      commandRuns: [
        {
          sessionId: "shell-1",
          id: 1,
          command: "npm test",
          status: "failed",
          startedAt: 1000,
          endedAt: 1100,
        },
      ],
      agentToolRuns: [],
      loopRuns: [],
    });
    expect(timeline[0]).toMatchObject({
      kind: "command",
      sessionId: "shell-1",
      id: 1,
      label: "npm test",
      status: "failed",
      startedAt: 1000,
    });
  });

  it("command の label が null なら (command) で埋める", () => {
    const timeline = mergeRunTimeline({
      commandRuns: [
        {
          sessionId: "shell-1",
          id: 2,
          command: null,
          status: "succeeded",
          startedAt: 500,
          endedAt: 600,
        },
      ],
      agentToolRuns: [],
      loopRuns: [],
    });
    expect(timeline[0]?.label).toBe("(command)");
  });

  it("limit で直近 N 件に絞る", () => {
    const commandRuns = Array.from({ length: 5 }, (_, i) => ({
      sessionId: "shell-1",
      id: i + 1,
      command: `c${i}`,
      status: "succeeded",
      startedAt: i * 100,
      endedAt: i * 100 + 10,
    }));
    const timeline = mergeRunTimeline({ commandRuns, agentToolRuns: [], loopRuns: [] }, 2);
    expect(timeline).toHaveLength(2);
    expect(timeline[0]?.startedAt).toBe(400);
  });
});
