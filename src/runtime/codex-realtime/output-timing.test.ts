import { describe, expect, it } from "vitest";
import { captureOutputTiming } from "./output-timing";

describe("output timing evidence", () => {
  it("records unmodified clocks and latency estimates in explicit units", () => {
    const sample = captureOutputTiming({
      currentTime: 80,
      baseLatency: 0.01,
      outputLatency: 0.08,
      getOutputTimestamp: () => ({ contextTime: 79.9, performanceTime: 2000 }),
    } as AudioContext);
    expect(sample).toMatchObject({
      contextTimeSeconds: 80,
      baseLatencySeconds: 0.01,
      outputLatencySeconds: 0.08,
      outputContextTimeSeconds: 79.9,
      outputPerformanceTimeMs: 2000,
    });
    expect(Number.isFinite(sample.performanceNowMs)).toBe(true);
  });
  it("leaves unsupported or invalid output timings absent rather than inventing a delay", () => {
    const context = { currentTime: 0, baseLatency: -1, outputLatency: NaN } as AudioContext;
    const sample = captureOutputTiming(context);
    expect(sample.baseLatencySeconds).toBeUndefined();
    expect(sample.outputLatencySeconds).toBeUndefined();
    expect(sample.outputContextTimeSeconds).toBeUndefined();
    expect(sample.outputPerformanceTimeMs).toBeUndefined();
  });
  it("tolerates unsupported timestamp calls and uses the new context clock after reconnect", () => {
    expect(
      captureOutputTiming({
        currentTime: 100,
        getOutputTimestamp: () => {
          throw new Error("unsupported");
        },
      } as unknown as AudioContext).outputContextTimeSeconds,
    ).toBeUndefined();
    expect(captureOutputTiming({ currentTime: 0 } as AudioContext).contextTimeSeconds).toBe(0);
  });
});
