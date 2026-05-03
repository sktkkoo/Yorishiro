/**
 * abandoned-factory の post-process pipeline.
 *
 * spec §8.1 の always-on layer + §8.3 の event-driven glitch:
 * 1. Brief glitch moments — CA spike + pixel jitter (30–90 秒周期)
 * 2. Lantern flicker sync — lantern dropout 時に CA も spike
 * 3. Heavy noise burst — VHS dropout 風 (数分に一度)
 *
 * leva controls (folder "abandoned-factory > post" / "abandoned-factory > glitch"):
 *   各 effect の主要パラメータを runtime 調整可能.
 */

import { useFrame } from "@react-three/fiber";
import {
  Bloom,
  ChromaticAberration,
  EffectComposer,
  Noise,
  Scanline,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { folder, useControls } from "leva";
import { BlendFunction, ToneMappingMode } from "postprocessing";
import { useMemo, useRef } from "react";
import { Vector2 } from "three";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";
import {
  createGlitchState,
  DEFAULT_GLITCH_PARAMS,
  type GlitchOutput,
  type GlitchState,
  updateGlitches,
} from "./event-glitches";
import { computeLanternFlicker, type FlickerParams } from "./flicker";

/**
 * always-on α+β post-process layer + event-driven glitch modulation.
 *
 * ToneMapping (ACES Filmic) → Bloom → ChromaticAberration → Noise →
 * Scanline → Vignette の順で適用.
 * glitch event 時は CA offset / noise opacity / scanline opacity を一時的に増幅.
 */
export function AbandonedFactoryPostProcess() {
  // --- always-on controls ---
  const [bloomControls, setBloom] = useControls("abandoned-factory", () => ({
    bloom: folder({
      bloomIntensity: { value: 0.85, min: 0, max: 3, step: 0.05 },
      bloomThreshold: { value: 0.2, min: 0, max: 1, step: 0.01 },
      bloomSmoothing: { value: 0.5, min: 0, max: 1, step: 0.01 },
    }),
  }));
  useControlsBridge("abandoned-factory", bloomControls, setBloom);

  const [caControls, setCa] = useControls("abandoned-factory", () => ({
    chromaticAberration: folder(
      {
        caOffsetX: { value: 0.0059, min: 0, max: 0.01, step: 0.0001 },
        caOffsetY: { value: 0.0059, min: 0, max: 0.01, step: 0.0001 },
      },
      { collapsed: true },
    ),
  }));
  useControlsBridge("abandoned-factory", caControls, setCa);

  const [noiseControls, setNoise] = useControls("abandoned-factory", () => ({
    noise: folder(
      {
        noiseOpacity: { value: 0.2, min: 0, max: 0.3, step: 0.005 },
      },
      { collapsed: true },
    ),
  }));
  useControlsBridge("abandoned-factory", noiseControls, setNoise);

  const [scanlineControls, setScanline] = useControls("abandoned-factory", () => ({
    scanline: folder(
      {
        scanlineDensity: { value: 0.8, min: 0.5, max: 5, step: 0.05 },
        scanlineOpacity: { value: 0.02, min: 0, max: 0.5, step: 0.01 },
      },
      { collapsed: true },
    ),
  }));
  useControlsBridge("abandoned-factory", scanlineControls, setScanline);

  const [vignetteControls, setVignette] = useControls("abandoned-factory", () => ({
    vignette: folder({
      vignetteOffset: { value: 0.03, min: 0, max: 1, step: 0.01 },
      vignetteDarkness: { value: 0.8, min: 0, max: 2, step: 0.01 },
    }),
  }));
  useControlsBridge("abandoned-factory", vignetteControls, setVignette);

  // --- glitch controls ---
  const [glitchControls, setGlitch] = useControls("abandoned-factory", () => ({
    glitch: folder(
      {
        briefIntervalMin: {
          value: DEFAULT_GLITCH_PARAMS.briefIntervalMin,
          min: 5,
          max: 120,
          step: 1,
          label: "brief 最小間隔(s)",
        },
        briefIntervalMax: {
          value: DEFAULT_GLITCH_PARAMS.briefIntervalMax,
          min: 10,
          max: 180,
          step: 1,
          label: "brief 最大間隔(s)",
        },
        briefDuration: {
          value: DEFAULT_GLITCH_PARAMS.briefDuration,
          min: 0.05,
          max: 0.5,
          step: 0.01,
          label: "brief 持続(s)",
        },
        briefCaMultiplier: {
          value: DEFAULT_GLITCH_PARAMS.briefCaMultiplier,
          min: 1,
          max: 10,
          step: 0.5,
          label: "brief CA 倍率",
        },
        lanternSyncThreshold: {
          value: DEFAULT_GLITCH_PARAMS.lanternSyncThreshold,
          min: 0.1,
          max: 1.0,
          step: 0.05,
          label: "lantern sync 閾値",
        },
        lanternSyncCaMultiplier: {
          value: DEFAULT_GLITCH_PARAMS.lanternSyncCaMultiplier,
          min: 1,
          max: 8,
          step: 0.5,
          label: "lantern sync CA 倍率",
        },
        heavyIntervalMin: {
          value: DEFAULT_GLITCH_PARAMS.heavyIntervalMin,
          min: 30,
          max: 600,
          step: 10,
          label: "heavy 最小間隔(s)",
        },
        heavyIntervalMax: {
          value: DEFAULT_GLITCH_PARAMS.heavyIntervalMax,
          min: 60,
          max: 900,
          step: 10,
          label: "heavy 最大間隔(s)",
        },
        heavyDuration: {
          value: DEFAULT_GLITCH_PARAMS.heavyDuration,
          min: 0.1,
          max: 1.0,
          step: 0.05,
          label: "heavy 持続(s)",
        },
        heavyNoiseAdd: {
          value: DEFAULT_GLITCH_PARAMS.heavyNoiseAdd,
          min: 0,
          max: 1,
          step: 0.05,
          label: "heavy noise 加算",
        },
        heavyScanlineMultiplier: {
          value: DEFAULT_GLITCH_PARAMS.heavyScanlineMultiplier,
          min: 1,
          max: 20,
          step: 1,
          label: "heavy scanline 倍率",
        },
      },
      { collapsed: true },
    ),
  }));
  useControlsBridge("abandoned-factory", glitchControls, setGlitch);

  const { bloomIntensity, bloomThreshold, bloomSmoothing } = bloomControls;
  const { caOffsetX, caOffsetY } = caControls;
  const { noiseOpacity } = noiseControls;
  const { scanlineDensity, scanlineOpacity } = scanlineControls;
  const { vignetteOffset, vignetteDarkness } = vignetteControls;

  // --- glitch state ---
  const glitchState = useRef<GlitchState | null>(null);
  const glitchOutput = useRef<GlitchOutput>({
    briefIntensity: 0,
    lanternSyncIntensity: 0,
    heavyIntensity: 0,
  });

  // CA / noise / scanline の ref. useFrame で direct mutation する.
  const caRef = useRef<{ offset: Vector2 } | null>(null);
  const noiseRef = useRef<{ blendMode: { opacity: { value: number } } } | null>(null);
  const scanlineRef = useRef<{ blendMode: { opacity: { value: number } } } | null>(null);

  // lights.tsx と同じ flickerAmount を参照するため leva を購読.
  // ここでは read-only で良いので useControls の get 側のみ.
  const [lightsControls] = useControls("abandoned-factory", () => ({
    lights: folder({
      flickerAmount: { value: 0.1, min: 0, max: 1, step: 0.05 },
    }),
  }));

  const flickerParams = useMemo<FlickerParams>(
    () => ({ flickerAmount: lightsControls.flickerAmount }),
    [lightsControls.flickerAmount],
  );

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    // glitch state を lazy init (clock は mount 後に進み始めるため)
    if (!glitchState.current) {
      glitchState.current = createGlitchState(t, glitchControls);
    }

    // lantern flicker を再計算 (lights.tsx と同じ pure function)
    const lanternRaw = computeLanternFlicker(t, flickerParams);

    // glitch 更新
    const output = updateGlitches(t, lanternRaw, glitchState.current, glitchControls);
    glitchOutput.current = output;

    // --- CA modulation ---
    if (caRef.current) {
      // base offset + glitch 増幅
      const caMultiplier =
        1 +
        output.briefIntensity * (glitchControls.briefCaMultiplier - 1) +
        output.lanternSyncIntensity * (glitchControls.lanternSyncCaMultiplier - 1);
      caRef.current.offset.set(caOffsetX * caMultiplier, caOffsetY * caMultiplier);
    }

    // --- Noise modulation ---
    if (noiseRef.current) {
      const noiseAdd = output.heavyIntensity * glitchControls.heavyNoiseAdd;
      noiseRef.current.blendMode.opacity.value = noiseOpacity + noiseAdd;
    }

    // --- Scanline modulation ---
    if (scanlineRef.current) {
      const scanMul = 1 + output.heavyIntensity * (glitchControls.heavyScanlineMultiplier - 1);
      scanlineRef.current.blendMode.opacity.value = scanlineOpacity * scanMul;
    }
  });

  return (
    <EffectComposer multisampling={0}>
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Bloom
        intensity={bloomIntensity}
        luminanceThreshold={bloomThreshold}
        luminanceSmoothing={bloomSmoothing}
        mipmapBlur
      />
      <ChromaticAberration
        ref={caRef}
        offset={new Vector2(caOffsetX, caOffsetY)}
        radialModulation={true}
        modulationOffset={0.5}
      />
      <Noise ref={noiseRef} opacity={noiseOpacity} blendFunction={BlendFunction.MULTIPLY} />
      <Scanline ref={scanlineRef} density={scanlineDensity} opacity={scanlineOpacity} />
      <Vignette offset={vignetteOffset} darkness={vignetteDarkness} />
    </EffectComposer>
  );
}
