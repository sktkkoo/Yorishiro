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
import {
  type AttentionLightSettingsStore,
  getAttentionLightSettingsStore,
} from "./attention-light-settings";

const ATTENTION_LIGHT_COLOR = "#ffb08a";
export const ATTENTION_FLASH_PULSE_COUNT = 2;
export const ATTENTION_FLASH_PULSE_DURATION_SECONDS = 1.7;
export const ATTENTION_FLASH_DURATION_SECONDS =
  ATTENTION_FLASH_PULSE_DURATION_SECONDS * ATTENTION_FLASH_PULSE_COUNT;
const MAX_COMPLETED_PULSE_IDENTITIES = 128;
const ATTENTION_FLASH_PEAK_INTENSITY: AttentionFlashLightIntensity = {
  ambient: 0.06,
  point: 0.55,
  spot: 0.65,
};

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
  if (elapsedSeconds <= 0 || elapsedSeconds >= ATTENTION_FLASH_DURATION_SECONDS) {
    return { ambient: 0, point: 0, spot: 0 };
  }
  const pulseElapsed = elapsedSeconds % ATTENTION_FLASH_PULSE_DURATION_SECONDS;
  const progress = pulseElapsed / ATTENTION_FLASH_PULSE_DURATION_SECONDS;
  const fade = progress < 0.5 ? smootherstep(progress * 2) : smootherstep((1 - progress) * 2);
  return {
    ambient: ATTENTION_FLASH_PEAK_INTENSITY.ambient * fade,
    point: ATTENTION_FLASH_PEAK_INTENSITY.point * fade,
    spot: ATTENTION_FLASH_PEAK_INTENSITY.spot * fade,
  };
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function smootherstep(value: number): number {
  const x = clamp01(value);
  return x * x * x * (x * (x * 6 - 15) + 10);
}

function getAttentionFlashLightPulseIdentity(state: AttentionFlashLightState): string | null {
  if (!state.active || state.sessionId === null || state.receivedAt === null) {
    return null;
  }
  return `${state.sessionId}:${state.receivedAt}`;
}

function rememberCompletedPulseIdentity(completed: Set<string>, identity: string): void {
  completed.add(identity);
  if (completed.size <= MAX_COMPLETED_PULSE_IDENTITIES) return;
  const oldest = completed.values().next().value;
  if (oldest !== undefined) completed.delete(oldest);
}

export interface AttentionFlashLightProps {
  readonly store?: SessionStatusStore;
  readonly settings?: AttentionLightSettingsStore;
}

/**
 * Runtime-owned attention light. This deliberately adds a transient red wash
 * without mutating scene-pack lights or their controls.
 */
export function AttentionFlashLight({
  store = getSessionStatusStore(),
  settings = getAttentionLightSettingsStore(),
}: AttentionFlashLightProps) {
  const [state, setState] = useState(() => readActiveSessionAttentionFlashLightState(store));
  const [enabled, setEnabled] = useState(() => settings.getEnabled());
  const [, setCompletedPulseVersion] = useState(0);
  const pulseOriginRef = useRef<number | null>(null);
  const pulseIdentityRef = useRef<string | null>(null);
  const completedPulseIdentitiesRef = useRef<Set<string>>(new Set());
  const ambientRef = useRef<AmbientLight>(null);
  const pointRef = useRef<PointLight>(null);
  const spotRef = useRef<SpotLight>(null);
  const pulseIdentity = getAttentionFlashLightPulseIdentity(state);
  const pulseCompleted =
    pulseIdentity !== null && completedPulseIdentitiesRef.current.has(pulseIdentity);

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

  useEffect(() => {
    setEnabled(settings.getEnabled());
    return settings.subscribe(() => {
      setEnabled(settings.getEnabled());
    });
  }, [settings]);

  useFrame(({ clock }) => {
    if (
      !enabled ||
      !state.active ||
      pulseIdentity === null ||
      completedPulseIdentitiesRef.current.has(pulseIdentity)
    ) {
      return;
    }
    if (pulseOriginRef.current === null) {
      pulseOriginRef.current = clock.elapsedTime;
    }
    const elapsed = Math.max(0, clock.elapsedTime - pulseOriginRef.current);
    if (elapsed >= ATTENTION_FLASH_DURATION_SECONDS) {
      const off = computeAttentionFlashLightIntensity(ATTENTION_FLASH_DURATION_SECONDS);
      if (ambientRef.current) ambientRef.current.intensity = off.ambient;
      if (pointRef.current) pointRef.current.intensity = off.point;
      if (spotRef.current) spotRef.current.intensity = off.spot;
      pulseOriginRef.current = null;
      rememberCompletedPulseIdentity(completedPulseIdentitiesRef.current, pulseIdentity);
      setCompletedPulseVersion((version) => version + 1);
      return;
    }
    const intensity = computeAttentionFlashLightIntensity(elapsed);
    if (ambientRef.current) ambientRef.current.intensity = intensity.ambient;
    if (pointRef.current) pointRef.current.intensity = intensity.point;
    if (spotRef.current) spotRef.current.intensity = intensity.spot;
  });

  if (!enabled || !state.active || pulseIdentity === null || pulseCompleted) return null;

  const initialIntensity = computeAttentionFlashLightIntensity(0);
  return (
    <group name="charminal-attention-flash-light">
      <ambientLight
        ref={ambientRef}
        color={ATTENTION_LIGHT_COLOR}
        intensity={initialIntensity.ambient}
      />
      <pointLight
        ref={pointRef}
        color={ATTENTION_LIGHT_COLOR}
        position={[0, 1.45, 0.85]}
        distance={2.8}
        decay={1.6}
        intensity={initialIntensity.point}
      />
      <spotLight
        ref={spotRef}
        color={ATTENTION_LIGHT_COLOR}
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
