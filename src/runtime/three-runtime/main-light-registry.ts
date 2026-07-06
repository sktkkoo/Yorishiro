import { Color, type ColorRepresentation, type Light } from "three";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";

export interface MainLightBaseline {
  readonly intensity: number;
  readonly color: ColorRepresentation;
}

export interface RegisteredMainLight {
  readonly light: Light;
  readonly baseline: {
    readonly intensity: number;
    readonly color: Color;
  };
}

export interface MainLightRegistration {
  update(baseline: MainLightBaseline): void;
  dispose(): void;
}

export class MainLightRegistry {
  private readonly entries = new Map<Light, RegisteredMainLight>();

  register(light: Light, baseline: MainLightBaseline): MainLightRegistration {
    this.entries.set(light, toEntry(light, baseline));
    let disposed = false;
    return {
      update: (nextBaseline) => {
        if (disposed) return;
        this.entries.set(light, toEntry(light, nextBaseline));
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.entries.delete(light);
      },
    };
  }

  getEntries(): readonly RegisteredMainLight[] {
    return Array.from(this.entries.values());
  }
}

function toEntry(light: Light, baseline: MainLightBaseline): RegisteredMainLight {
  return {
    light,
    baseline: {
      intensity: baseline.intensity,
      color: new Color(baseline.color),
    },
  };
}

export function getMainLightRegistry(): MainLightRegistry {
  return getOrInit(KEYS.MAIN_LIGHT_REGISTRY, () => new MainLightRegistry());
}
