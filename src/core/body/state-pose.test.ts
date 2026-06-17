import { describe, expect, it } from "vitest";
import { STATE_POSE, StatePoseBlender } from "./state-pose";

const DT = 1 / 60;

describe("StatePoseBlender", () => {
  it("初期状態は idle の値", () => {
    const b = new StatePoseBlender();
    expect(b.swayScale).toBe(STATE_POSE.idle.swayScale);
    expect(b.spinePitch).toBe(STATE_POSE.idle.spinePitch);
  });

  it("setState 後、十分 update すると target 値に収束する", () => {
    const b = new StatePoseBlender();
    b.setState("reading");
    for (let t = 0; t < 3; t += DT) b.update(DT);
    expect(b.spinePitch).toBeCloseTo(STATE_POSE.reading.spinePitch, 3);
    expect(b.headPitch).toBeCloseTo(STATE_POSE.reading.headPitch, 3);
    expect(b.swayScale).toBeCloseTo(STATE_POSE.reading.swayScale, 3);
    expect(b.driftAmpScale).toBeCloseTo(STATE_POSE.reading.driftAmpScale, 3);
  });

  it("遷移は瞬間でなくクロスフェードする（途中値が中間にある）", () => {
    const b = new StatePoseBlender();
    b.setState("writing");
    b.update(DT);
    expect(b.spinePitch).toBeGreaterThan(0);
    expect(b.spinePitch).toBeLessThan(STATE_POSE.writing.spinePitch);
  });

  it("reading と writing は同一ポーズ(集中作業に統合) / work は idle より静か", () => {
    expect(STATE_POSE.reading).toBe(STATE_POSE.writing);
    expect(STATE_POSE.reading.swayScale).toBeLessThan(STATE_POSE.idle.swayScale);
    expect(STATE_POSE.thinking.swayScale).toBeLessThan(STATE_POSE.idle.swayScale);
  });
});
