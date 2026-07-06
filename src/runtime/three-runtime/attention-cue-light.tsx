/**
 * AttentionCueLight — scene 所有の共有 attention cue light component。
 *
 * 位置づけ（照明通知の scene 所有化 計画 Task 4）:
 *   - 旧 runtime 直注入の `attention-flash-light.tsx` を置き換える。あちらは
 *     R3fRuntimeRoot が無条件に mount する runtime-owned な light だったが、
 *     こちらは scene pack が明示的に mount する共有 component として提供する。
 *   - 「いつ光らせるか」は `AttentionLightCueStore`（Task 2）が一元管理し、
 *     `seq` の変化で envelope（Task 4 冒頭で移植した 2-pulse 純関数）を最初から
 *     再生する。このファイルは envelope の適用先（light の生成・配置・
 *     intensity 反映）だけを担当する。
 *   - 何も mount しない scene のために、R3fRuntimeRoot 側に default cue light
 *     （`DefaultAttentionCueLight`）を用意し、"yielding default" として動く：
 *     scene が `AttentionCueLight` を mount すれば claim count が増え、
 *     default は黙って退く（`attention-cue-claims.ts` 参照）。
 */

import { useFrame } from "@react-three/fiber";
import { useEffect, useRef, useState } from "react";
import type { AmbientLight, PointLight, SpotLight } from "three";
import {
  type AttentionLightCue,
  type AttentionLightCueStore,
  getAttentionLightCueStore,
} from "../attention-light-cue";
// barrel 経由で import する（"./three-runtime" を直接 import すると r3f-host.tsx の
// extend(THREE...) が module 読み込み時に評価され、test での mock 差し替えが効かない。
// r3f-runtime-root.tsx の前例に倣う）。
import { getThreeRuntime } from "../three-runtime";
import { getAttentionCueClaimRegistry } from "./attention-cue-claims";
import {
  ATTENTION_CUE_DURATION_SECONDS,
  computeAttentionCueLightIntensity,
  computeAttentionCueLightIntensityInto,
} from "./attention-cue-envelope";

const DEFAULT_COLOR = "#ffb08a";
const DEFAULT_FAILURE_COLOR = "#ff5f58";
const DEFAULT_INTENSITY_SCALE = 1.0;

// 自動配置オフセット。現行固定値（head≈1.35 想定の絶対座標）からの逆算値。
// 見え方は帰納的に調整する前提の暫定値。
const POINT_OFFSET: readonly [number, number, number] = [0, 0.1, 0.6];
const SPOT_OFFSET: readonly [number, number, number] = [-0.15, 0.55, 0.7];

type Anchor = { x: number; y: number; z: number } | null;

export interface AttentionCueLightProps {
  /** 未指定ならキャラ head 位置から自動計算（offset は const、帰納調整前提） */
  readonly position?: readonly [number, number, number];
  readonly color?: string;
  readonly failureColor?: string;
  readonly intensityScale?: number;
  /** test 注入用。省略時は real singleton。 */
  readonly cueStore?: AttentionLightCueStore;
  /** test 注入用。省略時は ThreeRuntime の VRM head bone。 */
  readonly getAnchor?: () => Anchor;
}

/** scene pack が明示的に mount する attention cue light。mount 中は claim を保持し、default を退かせる。 */
export function AttentionCueLight(props: AttentionCueLightProps) {
  useClaimAttentionCue();
  return <AttentionCueLightCore {...props} />;
}

export interface DefaultAttentionCueLightProps {
  /** test 注入用。省略時は real singleton。 */
  readonly cueStore?: AttentionLightCueStore;
}

/**
 * yielding default。scene が独自の `AttentionCueLight` を mount していない間だけ、
 * 自動配置（position 未指定 = head 位置基準）の cue light を描画する。
 *
 * 起動直後、scene がまだ mount されていない一瞬は claim が 0 のまま default が
 * 生きるが、その窓で cue が起きる可能性は実質無いため許容する。
 */
export function DefaultAttentionCueLight({ cueStore }: DefaultAttentionCueLightProps = {}) {
  const registry = getAttentionCueClaimRegistry();
  const [claimed, setClaimed] = useState(() => registry.getCount() > 0);

  useEffect(() => {
    setClaimed(registry.getCount() > 0);
    return registry.subscribe(() => {
      setClaimed(registry.getCount() > 0);
    });
  }, [registry]);

  if (claimed) return null;
  return <AttentionCueLightCore cueStore={cueStore} />;
}

/** 描画なしの claim hook。default cue light をただ退去させたいだけの scene が使う。 */
export function useClaimAttentionCue(): void {
  useEffect(() => {
    return getAttentionCueClaimRegistry().claim();
  }, []);
}

function AttentionCueLightCore({
  position,
  color = DEFAULT_COLOR,
  failureColor = DEFAULT_FAILURE_COLOR,
  intensityScale = DEFAULT_INTENSITY_SCALE,
  cueStore = getAttentionLightCueStore(),
  getAnchor = () => getThreeRuntime().getCharacterAnchor(),
}: AttentionCueLightProps) {
  const [cue, setCue] = useState<AttentionLightCue | null>(() => cueStore.getCurrent());
  const [, setCompletedVersion] = useState(0);
  const completedSeqRef = useRef<number | null>(null);
  const baseRef = useRef<Anchor>(null);
  const lastSeqForBaseRef = useRef<number | null>(null);

  useEffect(() => {
    setCue(cueStore.getCurrent());
    return cueStore.subscribe(() => {
      setCue(cueStore.getCurrent());
    });
  }, [cueStore]);

  const seq = cue?.seq ?? null;

  // 新しい seq が来たら envelope の起点をリセットし、anchor を 1 回だけ取得する
  // （anchor は追従しない: cue 開始時点のキャラ位置に据え置く）。
  if (lastSeqForBaseRef.current !== seq) {
    lastSeqForBaseRef.current = seq;
    const anchor = position ? { x: position[0], y: position[1], z: position[2] } : getAnchor();
    baseRef.current = anchor === null ? null : { x: anchor.x, y: anchor.y, z: anchor.z };
  }

  const base = baseRef.current;
  const seqCompleted = seq !== null && completedSeqRef.current === seq;

  if (seq === null || base === null || seqCompleted) return null;
  if (cue?.reason === "run-slow-completed") return null;

  return (
    <ActiveAttentionCueLight
      key={seq}
      base={base}
      color={cue?.reason === "run-failed" ? failureColor : color}
      intensityScale={intensityScale}
      onComplete={() => {
        completedSeqRef.current = seq;
        setCompletedVersion((version) => version + 1);
      }}
    />
  );
}

function ActiveAttentionCueLight({
  base,
  color,
  intensityScale,
  onComplete,
}: {
  readonly base: { readonly x: number; readonly y: number; readonly z: number };
  readonly color: string;
  readonly intensityScale: number;
  readonly onComplete: () => void;
}) {
  const pulseOriginRef = useRef<number | null>(null);
  const ambientRef = useRef<AmbientLight>(null);
  const pointRef = useRef<PointLight>(null);
  const spotRef = useRef<SpotLight>(null);
  const intensityRef = useRef({ ambient: 0, point: 0, spot: 0 });
  const completedRef = useRef(false);

  useFrame(({ clock }) => {
    if (pulseOriginRef.current === null) {
      pulseOriginRef.current = clock.elapsedTime;
    }
    const elapsed = Math.max(0, clock.elapsedTime - pulseOriginRef.current);
    if (elapsed >= ATTENTION_CUE_DURATION_SECONDS) {
      if (!completedRef.current) {
        completedRef.current = true;
        onComplete();
      }
      return;
    }
    const intensity = computeAttentionCueLightIntensityInto(elapsed, intensityRef.current);
    if (ambientRef.current) ambientRef.current.intensity = intensity.ambient * intensityScale;
    if (pointRef.current) pointRef.current.intensity = intensity.point * intensityScale;
    if (spotRef.current) spotRef.current.intensity = intensity.spot * intensityScale;
  });

  const initial = computeAttentionCueLightIntensity(0);
  const pointPosition: [number, number, number] = [
    base.x + POINT_OFFSET[0],
    base.y + POINT_OFFSET[1],
    base.z + POINT_OFFSET[2],
  ];
  const spotPosition: [number, number, number] = [
    base.x + SPOT_OFFSET[0],
    base.y + SPOT_OFFSET[1],
    base.z + SPOT_OFFSET[2],
  ];

  return (
    <group name="yorishiro-attention-cue-light">
      <ambientLight ref={ambientRef} color={color} intensity={initial.ambient * intensityScale} />
      <pointLight
        ref={pointRef}
        color={color}
        position={pointPosition}
        distance={2.8}
        decay={1.6}
        intensity={initial.point * intensityScale}
      />
      <spotLight
        ref={spotRef}
        color={color}
        position={spotPosition}
        angle={0.9}
        penumbra={0.72}
        distance={3.4}
        decay={1.3}
        intensity={initial.spot * intensityScale}
      />
    </group>
  );
}
