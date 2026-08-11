// @vitest-environment jsdom
import type { AmenityServiceHandle, AmenityServicesAPI } from "@yorishiro/sdk";
import React, { act } from "react";
import ReactDOM from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PomodoroUi } from "./ui";

describe("PomodoroUi", () => {
  let container: HTMLDivElement | null = null;
  let root: ReactDOM.Root | null = null;

  afterEach(() => {
    if (root !== null) {
      act(() => root?.unmount());
      root = null;
    }
    container?.remove();
    container = null;
  });

  async function render(amenities: AmenityServicesAPI): Promise<void> {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = ReactDOM.createRoot(container);
    await act(async () => {
      root?.render(React.createElement(PomodoroUi, { amenities }));
    });
  }

  it("reads pomodoro state through the public amenity service", async () => {
    const service: AmenityServiceHandle = {
      getState: vi.fn(async () => ({
        phase: "work",
        round: 1,
        totalRounds: 4,
        remainingMs: 65_000,
      })),
      execute: vi.fn(),
    };
    await render({ get: (id) => (id === "pomodoro" ? service : null) });

    expect(container?.textContent).toContain("WORK");
    expect(container?.textContent).toContain("01:05");
    expect(container?.textContent).toContain("1/4");
    expect(service.getState).toHaveBeenCalledTimes(1);
  });

  it("executes only the public stop command and hides the timer", async () => {
    const service: AmenityServiceHandle = {
      getState: async () => ({
        phase: "short-break",
        round: 2,
        totalRounds: 4,
        remainingMs: 30_000,
      }),
      execute: vi.fn(async () => ({ cancelled: true })),
    };
    await render({ get: () => service });
    const stop = container?.querySelector("button");

    expect(stop?.textContent).toBe("Stop");
    await act(async () => {
      stop?.click();
    });

    expect(service.execute).toHaveBeenCalledWith("stop");
    expect(container?.querySelector("button")).toBeNull();
  });

  it("renders nothing when the amenity service is unavailable", async () => {
    await render({ get: () => null });

    expect(container?.children).toHaveLength(0);
  });

  it("does not trust an invalid service state shape", async () => {
    await render({
      get: () => ({
        getState: async () => ({ phase: "danger", remainingMs: "forever" }),
        execute: vi.fn(),
      }),
    });

    expect(container?.children).toHaveLength(0);
  });
});
