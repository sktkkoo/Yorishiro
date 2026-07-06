import { PointLight } from "three";
import { describe, expect, it } from "vitest";
import { MainLightRegistry } from "./main-light-registry";

describe("MainLightRegistry", () => {
  it("register/update/dispose で main light の baseline を管理する", () => {
    const registry = new MainLightRegistry();
    const light = new PointLight("#ffffff", 1);
    const registration = registry.register(light, { intensity: 1.2, color: "#ffe8ea" });

    expect(registry.getEntries()).toHaveLength(1);
    expect(registry.getEntries()[0]?.baseline.intensity).toBe(1.2);

    registration.update({ intensity: 0.8, color: "#b9d5ff" });
    expect(registry.getEntries()[0]?.baseline.intensity).toBe(0.8);
    expect(registry.getEntries()[0]?.baseline.color.getHexString()).toBe("b9d5ff");

    registration.dispose();
    expect(registry.getEntries()).toHaveLength(0);
  });

  it("dispose は多重呼び出ししても no-op", () => {
    const registry = new MainLightRegistry();
    const light = new PointLight("#ffffff", 1);
    const registration = registry.register(light, { intensity: 1, color: "#ffffff" });

    registration.dispose();
    registration.dispose();

    expect(registry.getEntries()).toHaveLength(0);
  });
});
