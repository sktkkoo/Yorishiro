import { describe, expect, it } from "vitest";
import { resolveVisibleTerminalSessionIds } from "./visible-sessions";

const DEFAULT = "default-session";

describe("resolveVisibleTerminalSessionIds", () => {
  it("single session ではその session だけを表示する", () => {
    expect(
      resolveVisibleTerminalSessionIds({
        sessions: [DEFAULT],
        activeSessionId: DEFAULT,
        defaultSessionId: DEFAULT,
      }),
    ).toEqual([DEFAULT]);
  });

  it("active が shell のときは default + active shell を表示する", () => {
    expect(
      resolveVisibleTerminalSessionIds({
        sessions: [DEFAULT, "shell-1", "shell-2"],
        activeSessionId: "shell-2",
        defaultSessionId: DEFAULT,
      }),
    ).toEqual([DEFAULT, "shell-2"]);
  });

  it("active が default のときは default + 先頭 shell を表示する", () => {
    expect(
      resolveVisibleTerminalSessionIds({
        sessions: [DEFAULT, "shell-1", "shell-2"],
        activeSessionId: DEFAULT,
        defaultSessionId: DEFAULT,
      }),
    ).toEqual([DEFAULT, "shell-1"]);
  });

  it("default session が見つからない場合でも active を落とさない", () => {
    expect(
      resolveVisibleTerminalSessionIds({
        sessions: ["shell-1", "shell-2", "shell-3"],
        activeSessionId: "shell-3",
        defaultSessionId: DEFAULT,
      }),
    ).toEqual(["shell-1", "shell-3"]);
  });
});
