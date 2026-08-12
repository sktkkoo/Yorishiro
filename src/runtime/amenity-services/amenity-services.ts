/**
 * Ambient UI 用 amenity service bridge。
 *
 * registry 自体や AmenityHandle.tools は渡さず、active handle が opt-in した
 * service surface だけを、呼び出し時に再解決する facade として公開する。
 */

import type { AmenityServiceHandle, AmenityServicesAPI } from "@yorishiro/sdk";
import type { AmenityPackRegistry } from "../amenity-pack-registry";

function unavailable(id: string): Error {
  return new Error(`amenity service '${id}' is unavailable`);
}

export function createAmenityServices(registry: AmenityPackRegistry): AmenityServicesAPI {
  const resolve = (id: string): AmenityServiceHandle | null =>
    registry.getActiveHandle(id)?.service ?? null;

  return Object.freeze({
    get(id: string): AmenityServiceHandle | null {
      if (resolve(id) === null) return null;

      return Object.freeze({
        async getState(): Promise<unknown> {
          const service = resolve(id);
          if (service === null) throw unavailable(id);
          return service.getState();
        },
        async execute(command: string, params?: unknown): Promise<unknown> {
          const service = resolve(id);
          if (service === null) throw unavailable(id);
          return service.execute(command, params);
        },
      });
    },
  });
}
