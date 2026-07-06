import { describe, expect, it } from "vitest";
import { DEFAULT_SLOW_COMMAND_THRESHOLD_MS } from "../../runtime/workspace-attention";
import { shouldNotifyAttentionShiftForCommandRun } from "./command-run-reflex";

describe("shouldNotifyAttentionShiftForCommandRun", () => {
  it("長時間 run の完了では成功・失敗どちらも attention shift する", () => {
    expect(
      shouldNotifyAttentionShiftForCommandRun(
        { exitCode: 0, durationMs: DEFAULT_SLOW_COMMAND_THRESHOLD_MS },
        DEFAULT_SLOW_COMMAND_THRESHOLD_MS,
      ),
    ).toBe(true);
    expect(
      shouldNotifyAttentionShiftForCommandRun(
        { exitCode: 1, durationMs: DEFAULT_SLOW_COMMAND_THRESHOLD_MS + 1 },
        DEFAULT_SLOW_COMMAND_THRESHOLD_MS,
      ),
    ).toBe(true);
  });

  it("短い run や未完了 run では attention shift しない", () => {
    expect(
      shouldNotifyAttentionShiftForCommandRun(
        { exitCode: 1, durationMs: DEFAULT_SLOW_COMMAND_THRESHOLD_MS - 1 },
        DEFAULT_SLOW_COMMAND_THRESHOLD_MS,
      ),
    ).toBe(false);
    expect(
      shouldNotifyAttentionShiftForCommandRun(
        { exitCode: null, durationMs: DEFAULT_SLOW_COMMAND_THRESHOLD_MS },
        DEFAULT_SLOW_COMMAND_THRESHOLD_MS,
      ),
    ).toBe(false);
  });
});
