export type WindowedViewMode = "scene" | "portrait";

export interface ViewModeCamera {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type CallFramingTier = "normal" | "small-face";
export const CALL_SMALL_ENTER_WIDTH = 220;
export const CALL_SMALL_EXIT_WIDTH = 236;
export const CALL_TIER_TRANSITION_MS = 180;

export function resolveCallFramingTier(
  width: number,
  previous: CallFramingTier = "normal",
): CallFramingTier {
  if (previous === "normal" && width <= CALL_SMALL_ENTER_WIDTH) return "small-face";
  if (previous === "small-face" && width >= CALL_SMALL_EXIT_WIDTH) return "normal";
  return previous;
}

/**
 * Stable entry framing for each windowed presentation mode. These values are
 * intentionally independent of viewport size: resizing the native window must
 * not make the camera chase the user's drag gesture.
 */
export function entryCameraForViewMode(
  mode: WindowedViewMode,
  characterAnchorY?: number | null,
  callTier: CallFramingTier = "normal",
): ViewModeCamera {
  if (mode === "portrait") {
    const faceCenterY =
      typeof characterAnchorY === "number" && Number.isFinite(characterAnchorY)
        ? characterAnchorY + 0.02
        : 1.62;
    return { x: 0, y: faceCenterY, z: callTier === "small-face" ? 0.84 : 0.98 };
  }
  return { x: 0, y: 1.39, z: 0.985 };
}

export function acquireFixedViewModeCamera(
  mode: WindowedViewMode,
  acquire: (x: number, y: number, z: number) => { dispose(): void },
  characterAnchorY?: number | null,
): () => void {
  const camera = entryCameraForViewMode(mode, characterAnchorY);
  const fixedCamera = acquire(camera.x, camera.y, camera.z);
  return () => fixedCamera.dispose();
}

interface CallResizeSource {
  getWidth(): number;
  addEventListener(type: "resize", listener: () => void): void;
  removeEventListener(type: "resize", listener: () => void): void;
}

interface FixedCameraTarget {
  setTarget(x: number, y: number, z: number, durationMs: number): void;
  dispose(): void;
}

export function acquireResponsiveCallCamera(
  characterAnchorY: number | null | undefined,
  acquire: (x: number, y: number, z: number) => FixedCameraTarget,
  resizeSource: CallResizeSource,
): () => void {
  let tier = resolveCallFramingTier(resizeSource.getWidth());
  const initial = entryCameraForViewMode("portrait", characterAnchorY, tier);
  const fixedCamera = acquire(initial.x, initial.y, initial.z);
  const onResize = () => {
    const nextTier = resolveCallFramingTier(resizeSource.getWidth(), tier);
    if (nextTier === tier) return;
    tier = nextTier;
    const target = entryCameraForViewMode("portrait", characterAnchorY, tier);
    fixedCamera.setTarget(target.x, target.y, target.z, CALL_TIER_TRANSITION_MS);
  };
  resizeSource.addEventListener("resize", onResize);
  return () => {
    resizeSource.removeEventListener("resize", onResize);
    fixedCamera.dispose();
  };
}
