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
  EffectComposerContext,
  Noise,
  Scanline,
  ToneMapping,
  Vignette,
} from "@react-three/postprocessing";
import { folder, useControls } from "leva";
import {
  BlendFunction,
  ChromaticAberrationEffect,
  EffectPass,
  NoiseEffect,
  ScanlineEffect,
  ToneMappingMode,
} from "postprocessing";
import { useContext, useMemo, useRef } from "react";
import { Vector2 } from "three";
import { useControlsBridge } from "../../../../src/runtime/ui-state-store";
import {
  createGlitchState,
  DEFAULT_GLITCH_PARAMS,
  type GlitchParams,
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

  // lights.tsx と同じ flickerAmount を参照するため leva を購読.
  const [lightsControls] = useControls("abandoned-factory", () => ({
    lights: folder({
      flickerAmount: { value: 0.1, min: 0, max: 1, step: 0.05 },
    }),
  }));

  const caOffset = useMemo(() => new Vector2(caOffsetX, caOffsetY), [caOffsetX, caOffsetY]);

  return (
    <EffectComposer multisampling={0}>
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Bloom
        intensity={bloomIntensity}
        luminanceThreshold={bloomThreshold}
        luminanceSmoothing={bloomSmoothing}
        mipmapBlur
      />
      <ChromaticAberration offset={caOffset} radialModulation modulationOffset={0.5} />
      <Noise opacity={noiseOpacity} blendFunction={BlendFunction.MULTIPLY} />
      <Scanline density={scanlineDensity} opacity={scanlineOpacity} />
      <Vignette offset={vignetteOffset} darkness={vignetteDarkness} />
      <GlitchModulator
        caOffsetX={caOffsetX}
        caOffsetY={caOffsetY}
        noiseOpacity={noiseOpacity}
        scanlineOpacity={scanlineOpacity}
        glitchControls={glitchControls}
        flickerAmount={lightsControls.flickerAmount}
      />
    </EffectComposer>
  );
}

interface GlitchModulatorProps {
  readonly caOffsetX: number;
  readonly caOffsetY: number;
  readonly noiseOpacity: number;
  readonly scanlineOpacity: number;
  readonly glitchControls: GlitchParams;
  readonly flickerAmount: number;
}

/**
 * EffectComposer 内部で context 経由 composer.passes から effect を取得し、
 * glitch event に応じて per-frame mutation する。
 */
function GlitchModulator({
  caOffsetX,
  caOffsetY,
  noiseOpacity,
  scanlineOpacity,
  glitchControls,
  flickerAmount,
}: GlitchModulatorProps) {
  const { composer } = useContext(EffectComposerContext);

  const glitchState = useRef<GlitchState | null>(null);
  const effectsRef = useRef<{
    ca: ChromaticAberrationEffect | null;
    noise: NoiseEffect | null;
    scanline: ScanlineEffect | null;
  }>({ ca: null, noise: null, scanline: null });

  const flickerParams = useMemo<FlickerParams>(() => ({ flickerAmount }), [flickerAmount]);

  useFrame(({ clock }) => {
    const t = clock.getElapsedTime();

    // effect instances を lazy resolve（passes が構築されてから探す）
    if (!effectsRef.current.ca) {
      if (!composer) {
        console.warn("[glitch] composer is null");
      } else {
        console.log(
          "[glitch] passes:",
          composer.passes.length,
          composer.passes.map((p) => p.constructor.name),
        );
        for (const pass of composer.passes) {
          if (!(pass instanceof EffectPass)) {
            // instanceof check の失敗を確認
            if (pass.constructor.name === "EffectPass") {
              console.warn("[glitch] EffectPass instanceof 失敗 — module duplication?");
            }
            continue;
          }
          const effects = (pass as unknown as { effects: Iterable<unknown> }).effects;
          for (const effect of effects) {
            if (effect instanceof ChromaticAberrationEffect) effectsRef.current.ca = effect;
            else if (effect instanceof NoiseEffect) effectsRef.current.noise = effect;
            else if (effect instanceof ScanlineEffect) effectsRef.current.scanline = effect;
          }
        }
        console.log("[glitch] resolved:", {
          ca: !!effectsRef.current.ca,
          noise: !!effectsRef.current.noise,
          scanline: !!effectsRef.current.scanline,
        });
      }
    }

    // glitch state を lazy init
    if (!glitchState.current) {
      glitchState.current = createGlitchState(t, glitchControls);
    }

    const lanternRaw = computeLanternFlicker(t, flickerParams);
    const output = updateGlitches(t, lanternRaw, glitchState.current, glitchControls);

    // glitch 発火時にログ
    if (output.briefIntensity > 0 || output.heavyIntensity > 0) {
      console.log(
        "[glitch] ACTIVE brief:",
        output.briefIntensity.toFixed(2),
        "heavy:",
        output.heavyIntensity.toFixed(2),
      );
    }

    const { ca, noise, scanline } = effectsRef.current;

    // --- CA modulation ---
    if (ca) {
      const caMultiplier =
        1 +
        output.briefIntensity * (glitchControls.briefCaMultiplier - 1) +
        output.lanternSyncIntensity * (glitchControls.lanternSyncCaMultiplier - 1);
      ca.offset.set(caOffsetX * caMultiplier, caOffsetY * caMultiplier);
    }

    // --- Noise modulation ---
    if (noise) {
      const noiseAdd = output.heavyIntensity * glitchControls.heavyNoiseAdd;
      noise.blendMode.opacity.value = noiseOpacity + noiseAdd;
    }

    // --- Scanline modulation ---
    if (scanline) {
      const scanMul = 1 + output.heavyIntensity * (glitchControls.heavyScanlineMultiplier - 1);
      scanline.blendMode.opacity.value = scanlineOpacity * scanMul;
    }
  });

  return null;
}
