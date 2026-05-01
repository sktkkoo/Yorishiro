import type { ReactNode } from "react";

export interface R3fRuntimeRootProps {
  readonly children?: ReactNode;
}

/**
 * Root for ThreeRuntime-hosted R3F content.
 *
 * Phase 1 keeps this intentionally empty: it proves the custom root can share
 * the existing renderer/scene/camera without moving VRM or Body ownership yet.
 */
export function R3fRuntimeRoot({ children }: R3fRuntimeRootProps) {
  return <>{children}</>;
}
