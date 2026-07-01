import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import type { AmbientLight, PointLight, SpotLight } from "three";
import {
  getSessionStatusStore,
  type SessionAttention,
  type SessionStatus,
  type SessionStatusStore,
} from "../session-status";
import type { SessionId } from "../sessions/types";

const ATTENTION_RED = "#ff2f28";
export const ATTENTION_FLASH_HZ = 0.6;

export interface AttentionFlashLightState {
  readonly active: boolean;
  readonly sessionId: SessionId | null;
  readonly source: SessionAttention["source"] | null;
  readonly receivedAt: number | null;
}

export interface AttentionFlashLightIntensity {
  readonly ambient: number;
  readonly point: number;
  readonly spot: number;
}

const INACTIVE_STATE: AttentionFlashLightState = {
  active: false,
  sessionId: null,
  source: null,
  receivedAt: null,
};

export function deriveAttentionFlashLightState(
  status: SessionStatus | null,
): AttentionFlashLightState {
  if (status?.activity !== "awaiting-input" || status.attention === null) {
    return INACTIVE_STATE;
  }
  return {
    active: true,
    sessionId: status.sessionId,
    source: status.attention.source,
    receivedAt: status.attention.receivedAt,
  };
}

export function readActiveSessionAttentionFlashLightState(
  store: Pick<SessionStatusStore, "get" | "getActiveSessionId">,
): AttentionFlashLightState {
  const activeSessionId = store.getActiveSessionId();
  if (activeSessionId === null) return INACTIVE_STATE;
  return deriveAttentionFlashLightState(store.get(activeSessionId));
}

export function computeAttentionFlashLightIntensity(
  elapsedSeconds: number,
): AttentionFlashLightIntensity {
  const wave = (Math.sin(elapsedSeconds * Math.PI * 2 * ATTENTION_FLASH_HZ - Math.PI / 2) + 1) / 2;
  const eased = wave * wave;
  return {
    ambient: 0.04 + eased * 0.16,
    point: 0.35 + eased * 1.1,
    spot: 0.45 + eased * 1.35,
  };
}

export interface AttentionFlashLightProps {
  readonly store?: SessionStatusStore;
}

/**
 * Runtime-owned attention light. This deliberately adds a transient red wash
 * without mutating scene-pack lights or their controls.
 */
export function AttentionFlashLight({ store = getSessionStatusStore() }: AttentionFlashLightProps) {
  const [state, setState] = useState(() => readActiveSessionAttentionFlashLightState(store));
  const pulseOriginRef = useRef<number | null>(null);
  const pulseIdentityRef = useRef<string | null>(null);
  const ambientRef = useRef<AmbientLight>(null);
  const pointRef = useRef<PointLight>(null);
  const spotRef = useRef<SpotLight>(null);
  const pulseIdentity = state.active
    ? `${state.sessionId ?? ""}:${state.receivedAt ?? ""}`
    : "inactive";

  if (pulseIdentityRef.current !== pulseIdentity) {
    pulseIdentityRef.current = pulseIdentity;
    pulseOriginRef.current = null;
  }

  useEffect(() => {
    setState(readActiveSessionAttentionFlashLightState(store));
    return store.subscribe(() => {
      setState(readActiveSessionAttentionFlashLightState(store));
    });
  }, [store]);

  useFrame(({ clock }) => {
    if (!state.active) return;
    if (pulseOriginRef.current === null) {
      pulseOriginRef.current = clock.elapsedTime;
    }
    const elapsed = Math.max(0, clock.elapsedTime - pulseOriginRef.current);
    const intensity = computeAttentionFlashLightIntensity(elapsed);
    if (ambientRef.current) ambientRef.current.intensity = intensity.ambient;
    if (pointRef.current) pointRef.current.intensity = intensity.point;
    if (spotRef.current) spotRef.current.intensity = intensity.spot;
  });

  if (!state.active) return null;

  const initialIntensity = computeAttentionFlashLightIntensity(0);
  return (
    <group name="charminal-attention-flash-light">
      <ambientLight ref={ambientRef} color={ATTENTION_RED} intensity={initialIntensity.ambient} />
      <pointLight
        ref={pointRef}
        color={ATTENTION_RED}
        position={[0, 1.45, 0.85]}
        distance={2.8}
        decay={1.6}
        intensity={initialIntensity.point}
      />
      <spotLight
        ref={spotRef}
        color={ATTENTION_RED}
        position={[-0.15, 2.0, 0.95]}
        angle={0.9}
        penumbra={0.72}
        distance={3.4}
        decay={1.3}
        intensity={initialIntensity.spot}
      />
    </group>
  );
}
