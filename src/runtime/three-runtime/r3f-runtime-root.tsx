import { useFrame } from "@react-three/fiber";
import { type ReactNode, useMemo, useRef } from "react";
import type * as THREE from "three";

export interface R3fRuntimeRootProps {
  readonly children?: ReactNode;
}

/**
 * Root for ThreeRuntime-hosted R3F content.
 *
 * Phase 1 keeps production output empty: it proves the custom root can share
 * the existing renderer/scene/camera without moving VRM or Body ownership yet.
 * Set localStorage["charminal:r3f-smoke"] = "1" before reload to show the
 * small smoke cube and confirm useFrame is driven by ThreeRuntime's RAF loop.
 */
export function R3fRuntimeRoot({ children }: R3fRuntimeRootProps) {
  const smokeEnabled = useMemo(() => {
    try {
      return localStorage.getItem("charminal:r3f-smoke") === "1";
    } catch {
      return false;
    }
  }, []);

  return (
    <>
      {smokeEnabled ? <R3fSmokeCube /> : null}
      {children}
    </>
  );
}

function R3fSmokeCube() {
  const meshRef = useRef<THREE.Mesh>(null);

  useFrame((_, delta) => {
    const mesh = meshRef.current;
    if (!mesh) return;
    mesh.rotation.x += delta * 0.7;
    mesh.rotation.y += delta * 1.1;
  });

  return (
    <mesh ref={meshRef} position={[0.65, 1.25, -0.25]} scale={0.08}>
      <boxGeometry args={[1, 1, 1]} />
      <meshBasicMaterial color="#4dd9cf" wireframe />
    </mesh>
  );
}
