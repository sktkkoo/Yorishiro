import type { AmenityHandle, AmenityServiceHandle } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import { AmenityPackRegistryImpl } from "../amenity-pack-registry";
import { createAmenityServices } from "./amenity-services";

function register(
  registry: AmenityPackRegistryImpl,
  id: string,
  service?: AmenityServiceHandle,
): AmenityHandle {
  const handle: AmenityHandle = { tools: {}, service, dispose: vi.fn() };
  registry.register({
    id,
    origin: "bundled",
    manifest: {
      id,
      type: "amenity",
      version: "1.0.0",
      yorishiroVersion: "^0.7.0",
      entry: "amenity.ts",
    },
    handle,
  });
  return handle;
}

describe("createAmenityServices", () => {
  it("resolves only an active amenity's opt-in service surface", async () => {
    const registry = new AmenityPackRegistryImpl();
    const service: AmenityServiceHandle = {
      getState: vi.fn(async () => ({ phase: "work" })),
      execute: vi.fn(async (command) => ({ command })),
    };
    register(registry, "pomodoro", service);
    const amenities = createAmenityServices(registry);

    expect(amenities.get("pomodoro")).toBeNull();
    registry.enable("pomodoro");

    const exposed = amenities.get("pomodoro");
    expect(exposed).not.toBeNull();
    await expect(exposed?.getState()).resolves.toEqual({ phase: "work" });
    await expect(exposed?.execute("stop")).resolves.toEqual({ command: "stop" });
    expect(exposed).not.toBe(service);
    expect("tools" in (exposed as unknown as object)).toBe(false);
  });

  it("does not expose an active amenity that omitted the public service", () => {
    const registry = new AmenityPackRegistryImpl();
    register(registry, "private-amenity");
    registry.enable("private-amenity");

    expect(createAmenityServices(registry).get("private-amenity")).toBeNull();
  });

  it("re-resolves a cached facade so disable cannot leave a live stale service", async () => {
    const registry = new AmenityPackRegistryImpl();
    register(registry, "pomodoro", {
      getState: async () => ({ phase: "work" }),
      execute: async () => ({ stopped: true }),
    });
    registry.enable("pomodoro");

    const exposed = createAmenityServices(registry).get("pomodoro");
    registry.disable("pomodoro");

    await expect(exposed?.getState()).rejects.toThrow("amenity service 'pomodoro' is unavailable");
    await expect(exposed?.execute("stop")).rejects.toThrow(
      "amenity service 'pomodoro' is unavailable",
    );
  });
});
