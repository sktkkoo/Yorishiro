// @vitest-environment jsdom

import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type SessionStatus, SessionStatusStore } from "../session-status";
import {
  ATTENTION_FLASH_HZ,
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

  it("keeps pulse intensity bounded and red-flash shaped", () => {
    const start = computeAttentionFlashLightIntensity(0);
    const peak = computeAttentionFlashLightIntensity(1 / (2 * ATTENTION_FLASH_HZ));

    expect(start.ambient).toBeGreaterThanOrEqual(0.04);
    expect(start.spot).toBeLessThan(peak.spot);
    expect(peak.ambient).toBeLessThanOrEqual(0.2);
    expect(peak.point).toBeLessThanOrEqual(1.451);
    expect(peak.spot).toBeLessThanOrEqual(1.8);
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
});
