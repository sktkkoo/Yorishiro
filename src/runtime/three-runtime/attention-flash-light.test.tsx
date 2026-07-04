// @vitest-environment jsdom

import { useFrame } from "@react-three/fiber";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionStatus, SessionStatusStore } from "../session-status";
import {
  ATTENTION_FLASH_DURATION_SECONDS,
  ATTENTION_FLASH_PULSE_DURATION_SECONDS,
  AttentionFlashLight,
  computeAttentionFlashLightIntensity,
  deriveAttentionFlashLightState,
  readActiveSessionAttentionFlashLightState,
} from "./attention-flash-light";
import { AttentionLightSettingsStore } from "./attention-light-settings";

vi.mock("@react-three/fiber", () => ({
  useFrame: vi.fn(),
}));

const status = (overrides: Partial<SessionStatus> = {}): SessionStatus => ({
  sessionId: "s1",
  lifecycle: "running",
  activity: "idle",
  exitCode: null,
  attention: null,
  lastActivityAt: 100,
  unread: false,
  ...overrides,
});

function makeStore() {
  let now = 100;
  const store = new SessionStatusStore({ now: () => now });
  return {
    store,
    tick: (next: number) => {
      now = next;
    },
  };
}

function runLatestFrame(elapsedTime: number) {
  const useFrameCalls = vi.mocked(useFrame).mock.calls;
  const frame = useFrameCalls[useFrameCalls.length - 1]?.[0] as unknown as
    | ((state: { clock: { elapsedTime: number } }) => void)
    | undefined;
  if (!frame) throw new Error("useFrame callback was not registered");
  act(() => {
    frame({ clock: { elapsedTime } });
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("attention flash light state", () => {
  it("activates only for awaiting-input session attention", () => {
    expect(
      deriveAttentionFlashLightState(status({ lifecycle: "exited", exitCode: 1 })).active,
    ).toBe(false);

    expect(
      deriveAttentionFlashLightState(
        status({
          activity: "awaiting-input",
          attention: {
            title: "Codex",
            body: "Permission requested",
            receivedAt: 200,
            source: "hook",
          },
        }),
      ),
    ).toEqual({
      active: true,
      sessionId: "s1",
      source: "hook",
      receivedAt: 200,
    });
  });

  it("reads the active session from SessionStatusStore", () => {
    const { store } = makeStore();
    store.register("s1");
    store.register("s2");
    store.markActive("s1");
    store.markAttentionRequest("s2", {
      title: "Claude",
      body: "Permission needed",
      source: "screen",
    });

    expect(readActiveSessionAttentionFlashLightState(store).active).toBe(false);

    store.markActive("s2");

    expect(readActiveSessionAttentionFlashLightState(store)).toMatchObject({
      active: true,
      sessionId: "s2",
      source: "screen",
    });
  });

  it("keeps pulse intensity bounded and fade-in/out shaped", () => {
    const start = computeAttentionFlashLightIntensity(0);
    const rising = computeAttentionFlashLightIntensity(
      ATTENTION_FLASH_PULSE_DURATION_SECONDS * 0.25,
    );
    const firstPeak = computeAttentionFlashLightIntensity(
      ATTENTION_FLASH_PULSE_DURATION_SECONDS * 0.5,
    );
    const falling = computeAttentionFlashLightIntensity(
      ATTENTION_FLASH_PULSE_DURATION_SECONDS * 0.75,
    );
    const betweenPulses = computeAttentionFlashLightIntensity(
      ATTENTION_FLASH_PULSE_DURATION_SECONDS,
    );
    const secondPeak = computeAttentionFlashLightIntensity(
      ATTENTION_FLASH_PULSE_DURATION_SECONDS * 1.5,
    );
    const end = computeAttentionFlashLightIntensity(ATTENTION_FLASH_DURATION_SECONDS);

    expect(start).toEqual({ ambient: 0, point: 0, spot: 0 });
    expect(rising.spot).toBeGreaterThan(start.spot);
    expect(firstPeak.spot).toBeGreaterThan(rising.spot);
    expect(falling.spot).toBeCloseTo(rising.spot);
    expect(betweenPulses).toEqual({ ambient: 0, point: 0, spot: 0 });
    expect(secondPeak.ambient).toBeCloseTo(firstPeak.ambient);
    expect(secondPeak.point).toBeCloseTo(firstPeak.point);
    expect(secondPeak.spot).toBeCloseTo(firstPeak.spot);
    expect(end).toEqual({ ambient: 0, point: 0, spot: 0 });
    expect(firstPeak.ambient).toBeCloseTo(0.06);
    expect(firstPeak.point).toBeCloseTo(0.55);
    expect(firstPeak.spot).toBeCloseTo(0.65);
  });
});

describe("AttentionFlashLight", () => {
  it("mounts and unmounts the additive runtime light with active-session attention", () => {
    const { store, tick } = makeStore();
    store.register("s1");
    store.register("s2");
    store.markActive("s1");

    const { container } = render(<AttentionFlashLight store={store} />);
    expect(container.querySelector("[name='charminal-attention-flash-light']")).toBeNull();

    act(() => {
      tick(200);
      store.markAttentionRequest("s1", {
        title: "Codex",
        body: "Approval requested",
        source: "hook",
      });
    });

    expect(container.querySelector("[name='charminal-attention-flash-light']")).not.toBeNull();

    act(() => {
      store.markActive("s2");
    });

    expect(container.querySelector("[name='charminal-attention-flash-light']")).toBeNull();
  });

  it("does not mount while lighting notifications are disabled", () => {
    const { store, tick } = makeStore();
    const settings = new AttentionLightSettingsStore();
    settings.setEnabled(false);
    store.register("s1");
    store.markActive("s1");

    const { container } = render(<AttentionFlashLight store={store} settings={settings} />);

    act(() => {
      tick(200);
      store.markAttentionRequest("s1", {
        title: "Codex",
        body: "Approval requested",
        source: "hook",
      });
    });

    expect(container.querySelector("[name='charminal-attention-flash-light']")).toBeNull();

    act(() => {
      settings.setEnabled(true);
    });

    expect(container.querySelector("[name='charminal-attention-flash-light']")).not.toBeNull();
  });

  it("flashes once per attention request and stays quiet while that request remains active", () => {
    const { store, tick } = makeStore();
    store.register("s1");
    store.markActive("s1");

    const { container } = render(<AttentionFlashLight store={store} />);

    act(() => {
      tick(200);
      store.markAttentionRequest("s1", {
        title: "Codex",
        body: "Approval requested",
        source: "hook",
      });
    });

    expect(container.querySelector("[name='charminal-attention-flash-light']")).not.toBeNull();

    runLatestFrame(10);
    expect(container.querySelector("[name='charminal-attention-flash-light']")).not.toBeNull();

    runLatestFrame(10 + ATTENTION_FLASH_DURATION_SECONDS + 0.01);
    expect(container.querySelector("[name='charminal-attention-flash-light']")).toBeNull();

    runLatestFrame(30);
    expect(container.querySelector("[name='charminal-attention-flash-light']")).toBeNull();

    act(() => {
      tick(400);
      store.markAttentionRequest("s1", {
        title: "Codex",
        body: "Second approval requested",
        source: "hook",
      });
    });

    expect(container.querySelector("[name='charminal-attention-flash-light']")).not.toBeNull();
  });

  it("does not reflash when screen detection confirms an already pulsed hook attention", () => {
    const { store, tick } = makeStore();
    store.register("s1");
    store.markActive("s1");

    const { container } = render(<AttentionFlashLight store={store} />);

    act(() => {
      tick(200);
      store.markAttentionRequest("s1", {
        title: "Codex",
        body: "Approval requested",
        source: "hook",
      });
    });

    runLatestFrame(10);
    runLatestFrame(10 + ATTENTION_FLASH_DURATION_SECONDS + 0.01);
    expect(container.querySelector("[name='charminal-attention-flash-light']")).toBeNull();

    act(() => {
      tick(300);
      store.markScreenAttentionRequest("s1", {
        title: "Codex",
        body: "Allow command?",
      });
    });

    expect(readActiveSessionAttentionFlashLightState(store)).toMatchObject({
      active: true,
      source: "screen",
      receivedAt: 200,
    });
    expect(container.querySelector("[name='charminal-attention-flash-light']")).toBeNull();
  });
});
