import { describe, expect, it, vi } from "vitest";
import {
  parseRecordedBodyManifest,
  type RecordedBodyManifest,
  type RecordedBodyPlayback,
  RecordedBodySequencer,
} from "./recorded-body-sequencer";

const modelSha256 = "a".repeat(64);
const idleUnit = {
  id: "quiet-shift",
  animation: "/animations/recorded-body/quiet.vrma",
  context: "idle" as const,
  startTimeSec: 2,
  endTimeSec: 8,
  contactWindows: [{ startTimeSec: 1, endTimeSec: 10, feet: "both" as const }],
};
const speechUnit = {
  ...idleUnit,
  id: "explain-shift",
  context: "speech" as const,
  animation: "/animations/recorded-body/chatting.vrma",
};
const manifest: RecordedBodyManifest = {
  schemaVersion: 1,
  targetModelSha256: modelSha256,
  units: [idleUnit, speechUnit],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function playback() {
  const result = {
    id: 1,
    phaseSec: 2,
    held: false as boolean,
    paused: false as boolean,
    completion: new Promise<void>(() => {}),
    stop: vi.fn(async () => {}),
    cancel: vi.fn(),
    setUpperWeight: vi.fn(),
    setPaused: vi.fn((paused: boolean) => {
      result.paused = paused;
    }),
  } satisfies RecordedBodyPlayback;
  return result;
}
function setup(input: unknown = manifest) {
  const active = playback();
  const preloadRecordedBase = vi.fn(async () => true);
  const playRecordedBase = vi.fn(
    async (
      _ref: string,
      _options: {
        isCurrent: () => boolean;
        onCommit?: () => void;
        getInitialState?: () => { paused: boolean; upperWeight: number };
      },
    ) => active,
  );
  const onCommit = vi.fn();
  const loadManifest = vi.fn(async () => input);
  const sequencer = new RecordedBodySequencer(
    { preloadRecordedBase, playRecordedBase },
    { modelSha256, loadManifest, random: () => 0, onCommit },
  );
  return { sequencer, active, preloadRecordedBase, playRecordedBase, onCommit, loadManifest };
}
async function flush() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("recorded whole-body sequencing", () => {
  it("requires the exact reviewed avatar and contact-qualified unit endpoints", () => {
    expect(parseRecordedBodyManifest(manifest, modelSha256)).toEqual(manifest);
    expect(parseRecordedBodyManifest(manifest, "b".repeat(64))).toBeNull();
    for (const contactWindows of [[], [null], [{ startTimeSec: 3, endTimeSec: 7, feet: "both" }]]) {
      expect(
        parseRecordedBodyManifest(
          { ...manifest, units: [{ ...idleUnit, contactWindows }] },
          modelSha256,
        ),
      ).toBeNull();
    }
  });

  it("keeps existing playback when the optional bundle is absent or for another avatar", async () => {
    for (const input of [null, { ...manifest, targetModelSha256: "other" }]) {
      const { sequencer, preloadRecordedBase, playRecordedBase } = setup(input);
      await sequencer.prepare();
      sequencer.update(16, true, "idle");
      await flush();
      expect(preloadRecordedBase).not.toHaveBeenCalled();
      expect(playRecordedBase).not.toHaveBeenCalled();
      expect(sequencer.active).toBe(false);
    }
  });

  it("establishes an idle source stance before display, without a foot-sliding rest fade", async () => {
    const { sequencer, playRecordedBase } = setup();
    await sequencer.initialize();
    expect(playRecordedBase).toHaveBeenCalledOnce();
    expect(playRecordedBase.mock.calls[0][0]).toBe(idleUnit.animation);
    expect(playRecordedBase.mock.calls[0][1]).toMatchObject({ initialPose: true, fadeInMs: 0 });
    expect(sequencer.ownsUpperBody).toBe(true);
    await sequencer.initialize();
    expect(playRecordedBase).toHaveBeenCalledOnce();
  });

  it("keeps near-one and reduced positive intensities on the same supporting performance", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.initialize(0.95);
    expect(playRecordedBase.mock.calls[0][1].getInitialState?.()).toEqual({
      paused: false,
      upperWeight: 0.95,
    });
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0.95, 0);
    sequencer.update(16, true, "idle", true, 0.5);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0.5, 350);
    active.setUpperWeight.mockClear();
    for (let frame = 0; frame < 60; frame++) sequencer.update(16, true, "idle", true, 0.5);
    expect(active.setUpperWeight).not.toHaveBeenCalled();
    expect(active.stop).not.toHaveBeenCalled();
    expect(active.cancel).not.toHaveBeenCalled();
    expect(playRecordedBase).toHaveBeenCalledOnce();
    expect(sequencer.getSnapshot().active).toMatchObject({ paused: false, upperStrength: 0.5 });
  });

  it("pauses at zero without releasing support and resumes the current phase at positive strength", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.initialize(0.95);
    active.phaseSec = 4;
    sequencer.update(16, true, "idle", true, 0);
    expect(active.setPaused).toHaveBeenLastCalledWith(true);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 350);
    expect(sequencer.ownsUpperBody).toBe(false);
    for (let frame = 0; frame < 60; frame++) sequencer.update(16, true, "idle", true, 0);
    expect(playRecordedBase).toHaveBeenCalledOnce();
    sequencer.update(16, true, "idle", true, 0.95);
    expect(active.setPaused).toHaveBeenLastCalledWith(false);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0.95, 350);
    expect(sequencer.getSnapshot().active).toMatchObject({ phaseSec: 4, paused: false });
    expect(active.stop).not.toHaveBeenCalled();
    expect(active.cancel).not.toHaveBeenCalled();
    expect(playRecordedBase).toHaveBeenCalledOnce();
  });

  it("bootstraps a paused source stance at zero and does not choose successors at a held exit", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.initialize(0);
    expect(playRecordedBase.mock.calls[0][1].getInitialState?.()).toEqual({
      paused: true,
      upperWeight: 0,
    });
    expect(active.setPaused).toHaveBeenLastCalledWith(true);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 0);
    active.held = true;
    for (let frame = 0; frame < 120; frame++) sequencer.update(100, true, "idle", true, 0);
    expect(playRecordedBase).toHaveBeenCalledOnce();
    expect(sequencer.active).toBe(true);
    sequencer.update(16, true, "idle", true, 0.4);
    await flush();
    expect(playRecordedBase).toHaveBeenCalledTimes(2);
    expect(active.setPaused).toHaveBeenLastCalledWith(false);
  });

  it("applies the latest zero intensity atomically when a selected clip finishes loading", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    const pending = deferred<typeof active>();
    playRecordedBase.mockReturnValueOnce(pending.promise);
    await sequencer.prepare();
    sequencer.update(16, true, "idle", true, 0.95);
    const options = playRecordedBase.mock.calls[0][1];
    sequencer.update(16, true, "idle", true, 0);
    expect(options.isCurrent()).toBe(true);
    expect(options.getInitialState?.()).toEqual({ paused: true, upperWeight: 0 });
    pending.resolve(active);
    await flush();
    expect(active.setPaused).toHaveBeenLastCalledWith(true);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 0);
    expect(active.cancel).not.toHaveBeenCalled();
  });

  it("does not let strength changes restore upper ownership during listening", async () => {
    const { sequencer, active } = setup();
    await sequencer.initialize(0.95);
    sequencer.update(16, true, "idle", false, 0.95);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 650);
    active.setUpperWeight.mockClear();
    for (const intensity of [0.3, 0, 1, 0.95]) sequencer.update(16, true, "idle", false, intensity);
    expect(active.setUpperWeight).not.toHaveBeenCalled();
    expect(sequencer.ownsUpperBody).toBe(false);
    sequencer.update(16, true, "idle", true, 0.95);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0.95, 650);
  });

  it.each([
    [Number.NaN, 1],
    [Number.POSITIVE_INFINITY, 1],
    [-1, 0],
    [2, 1],
  ])("clamps intensity %s to %s consistently with Body", async (input, expected) => {
    const { sequencer, active } = setup();
    await sequencer.initialize(input);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(expected, 0);
    expect(active.paused).toBe(expected === 0);
  });

  it("does not start a new lower-body unit during the current authored performance", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.prepare();
    sequencer.update(16, true, "idle");
    await flush();
    for (let i = 0; i < 100; i++) sequencer.update(100, true, "idle");
    expect(playRecordedBase).toHaveBeenCalledOnce();
    expect(active.stop).not.toHaveBeenCalled();
    active.held = true;
    sequencer.update(16, true, "idle");
    await flush();
    expect(playRecordedBase).toHaveBeenCalledTimes(2);
  });

  it("retires speech arms on listening while keeping the supporting leg clock", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.prepare();
    sequencer.update(16, true, "speech");
    await flush();
    sequencer.update(16, true, "idle");
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 650);
    expect(active.stop).not.toHaveBeenCalled();
    expect(active.cancel).not.toHaveBeenCalled();
    expect(playRecordedBase).toHaveBeenCalledOnce();
    expect(sequencer.ownsUpperBody).toBe(false);
    expect(sequencer.active).toBe(true);
  });

  it("gives listening the upper body without cutting the current idle weight shift", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.initialize();
    sequencer.update(16, true, "idle", false);
    expect(sequencer.ownsUpperBody).toBe(false);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 650);
    expect(active.stop).not.toHaveBeenCalled();
    expect(playRecordedBase).toHaveBeenCalledOnce();
    sequencer.update(16, true, "idle", true);
    expect(sequencer.ownsUpperBody).toBe(true);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(1, 650);
  });

  it("invalidates a speech load when listening arrives before it can commit", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    const pending = deferred<typeof active>();
    playRecordedBase.mockReturnValueOnce(pending.promise);
    await sequencer.prepare();
    sequencer.update(16, true, "speech");
    const oldGuard = playRecordedBase.mock.calls[0][1].isCurrent;
    expect(oldGuard()).toBe(true);
    sequencer.update(16, true, "idle");
    expect(oldGuard()).toBe(false);
    pending.resolve(active);
    await flush();
    expect(active.cancel).toHaveBeenCalledOnce();
  });

  it("starts replacement legs with idle arms already suppressed during listening", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.initialize();
    sequencer.update(16, true, "idle", false);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 650);
    active.held = true;
    const incoming = playback();
    playRecordedBase.mockResolvedValueOnce(incoming);
    sequencer.update(16, true, "idle", false);
    await flush();
    expect(incoming.setUpperWeight).toHaveBeenCalledWith(0, 0);
    expect(sequencer.ownsUpperBody).toBe(false);
  });

  it("does not retire the quiet foundation while a candidate is pending or physically rejected", async () => {
    const { sequencer, playRecordedBase, onCommit } = setup();
    playRecordedBase.mockRejectedValue(new Error("incompatible feet"));
    await sequencer.prepare();
    sequencer.update(16, true, "idle");
    expect(sequencer.active).toBe(false);
    await flush();
    expect(onCommit).not.toHaveBeenCalled();
    for (let i = 0; i < 90; i++) sequencer.update(16, true, "idle");
    expect(playRecordedBase).toHaveBeenCalledOnce();
  });

  it("preserves a held supported pose if every next candidate is rejected", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.prepare();
    sequencer.update(16, true, "idle");
    await flush();
    active.held = true;
    playRecordedBase.mockRejectedValue(new Error("incompatible stance"));
    sequencer.update(16, true, "idle");
    await flush();
    expect(sequencer.getSnapshot().active?.id).toBe(idleUnit.id);
    expect(active.cancel).not.toHaveBeenCalled();
    expect(active.stop).not.toHaveBeenCalled();
  });

  it("tries another complete idle unit before repeating the same movement", async () => {
    const alternative = { ...idleUnit, id: "other-shift", startTimeSec: 4, endTimeSec: 9 };
    const { sequencer, active, playRecordedBase } = setup({
      ...manifest,
      units: [idleUnit, alternative],
    });
    await sequencer.initialize();
    active.held = true;
    sequencer.update(16, true, "idle");
    await flush();
    expect(playRecordedBase.mock.calls[1][1]).toMatchObject({ startTimeSec: 4, endTimeSec: 9 });
  });

  it("keeps moving with its compatible supported unit if the next activity has a different stance", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    await sequencer.initialize();
    active.held = true;
    playRecordedBase.mockRejectedValueOnce(new Error("speech stance incompatible"));
    sequencer.update(16, true, "speech");
    await flush();
    expect(playRecordedBase.mock.calls.map(([ref]) => ref)).toEqual([
      idleUnit.animation,
      speechUnit.animation,
      idleUnit.animation,
    ]);
    expect(active.setUpperWeight).toHaveBeenLastCalledWith(0, 0);
    expect(active.stop).not.toHaveBeenCalled();
  });

  it("honors external body ownership even if a loading candidate resolves late", async () => {
    const { sequencer, active, playRecordedBase } = setup();
    const pending = deferred<typeof active>();
    playRecordedBase.mockReturnValueOnce(pending.promise);
    await sequencer.prepare();
    sequencer.update(16, true, "idle");
    sequencer.suspend(0);
    expect(playRecordedBase.mock.calls[0][1].isCurrent()).toBe(false);
    pending.resolve(active);
    await flush();
    expect(active.cancel).toHaveBeenCalledOnce();
    expect(sequencer.active).toBe(false);
  });
});
