import { useEffect } from "react";
import type { ThreeRuntime } from "./three-runtime/types";
import {
  acquireFixedViewModeCamera,
  acquireResponsiveCallCamera,
  defaultCameraForCharacter,
  type WindowedViewMode,
} from "./view-mode-framing";

type CameraRuntime = Pick<
  ThreeRuntime,
  "setCameraBase" | "getCharacterAnchor" | "acquireFixedCamera"
>;

/** Body identity changes only on load/unload, never as the resident moves. */
export function useViewModeCamera(
  mode: WindowedViewMode | null,
  body: object | null,
  runtime: CameraRuntime,
): void {
  useEffect(() => {
    if (mode === null) {
      const camera = defaultCameraForCharacter(runtime.getCharacterAnchor());
      runtime.setCameraBase(camera.x, camera.y, camera.z);
    }
  }, [mode, runtime]);
  useEffect(() => {
    if (mode === null) return;
    // Let VRM loading initialize the normal camera first. Claiming it earlier
    // skips that initialization and freezes Call at a fallback head height,
    // also retaining the uninitialized camera as its restore destination.
    if (body === null) return;
    if (mode === "portrait") {
      return acquireResponsiveCallCamera(
        runtime.getCharacterAnchor()?.y,
        runtime.acquireFixedCamera.bind(runtime),
        {
          getWidth: () => window.innerWidth,
          addEventListener: (_type, listener) => window.addEventListener("resize", listener),
          removeEventListener: (_type, listener) => window.removeEventListener("resize", listener),
        },
      );
    }
    return acquireFixedViewModeCamera(mode, runtime.acquireFixedCamera.bind(runtime));
  }, [mode, body, runtime]);
}
