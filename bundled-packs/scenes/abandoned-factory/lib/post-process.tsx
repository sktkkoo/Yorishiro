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
  type ChromaticAberrationEffect,
  Effect,
  EffectPass,
  type NoiseEffect,
  type ScanlineEffect,
  ToneMappingMode,
} from "postprocessing";
import { useContext, useEffect, useMemo, useRef } from "react";
import { Uniform, Vector2 } from "three";
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
      bloomIntensity: { value: 1.2, min: 0, max: 3, step: 0.05 },
      bloomThreshold: { value: 0.14, min: 0, max: 1, step: 0.01 },
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
        noiseOpacity: { value: 0.195, min: 0, max: 0.3, step: 0.005 },
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
          min: 1,
          max: 120,
          step: 1,
          label: "brief min interval(s)",
        },
        briefIntervalMax: {
          value: DEFAULT_GLITCH_PARAMS.briefIntervalMax,
          min: 2,
          max: 180,
          step: 1,
          label: "brief max interval(s)",
        },
        briefDuration: {
          value: DEFAULT_GLITCH_PARAMS.briefDuration,
          min: 0.05,
          max: 0.5,
          step: 0.01,
          label: "brief duration(s)",
        },
        briefCaMultiplier: {
          value: DEFAULT_GLITCH_PARAMS.briefCaMultiplier,
          min: 1,
          max: 10,
          step: 0.5,
          label: "brief CA mult",
        },
        briefBlockStrength: {
          value: DEFAULT_GLITCH_PARAMS.briefBlockStrength,
          min: 0,
          max: 3,
          step: 0.05,
          label: "brief block str",
        },
        lanternSyncThreshold: {
          value: DEFAULT_GLITCH_PARAMS.lanternSyncThreshold,
          min: 0.1,
          max: 1.0,
          step: 0.05,
          label: "lantern sync threshold",
        },
        lanternSyncCaMultiplier: {
          value: DEFAULT_GLITCH_PARAMS.lanternSyncCaMultiplier,
          min: 1,
          max: 8,
          step: 0.5,
          label: "lantern sync CA mult",
        },
        heavyIntervalMin: {
          value: DEFAULT_GLITCH_PARAMS.heavyIntervalMin,
          min: 5,
          max: 600,
          step: 1,
          label: "heavy min interval(s)",
        },
        heavyIntervalMax: {
          value: DEFAULT_GLITCH_PARAMS.heavyIntervalMax,
          min: 6,
          max: 900,
          step: 1,
          label: "heavy max interval(s)",
        },
        heavyDuration: {
          value: DEFAULT_GLITCH_PARAMS.heavyDuration,
          min: 0.1,
          max: 1.0,
          step: 0.05,
          label: "heavy duration(s)",
        },
        heavyNoiseAdd: {
          value: DEFAULT_GLITCH_PARAMS.heavyNoiseAdd,
          min: 0,
          max: 1,
          step: 0.05,
          label: "heavy noise add",
        },
        heavyScanlineMultiplier: {
          value: DEFAULT_GLITCH_PARAMS.heavyScanlineMultiplier,
          min: 1,
          max: 20,
          step: 1,
          label: "heavy scanline mult",
        },
        heavyBlockStrength: {
          value: DEFAULT_GLITCH_PARAMS.heavyBlockStrength,
          min: 0,
          max: 3,
          step: 0.05,
          label: "heavy block str",
        },
        blockColumns: {
          value: DEFAULT_GLITCH_PARAMS.blockColumns,
          min: 0.005,
          max: 0.12,
          step: 0.005,
          label: "block width",
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
  const glitchEffect = useMemo(() => new EventGlitchEffect(), []);

  useEffect(() => () => glitchEffect.dispose(), [glitchEffect]);

  return (
    <EffectComposer multisampling={0}>
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Bloom
        intensity={bloomIntensity}
        luminanceThreshold={bloomThreshold}
        luminanceSmoothing={bloomSmoothing}
        mipmapBlur
      />
      <primitive object={glitchEffect} dispose={null} />
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
        glitchEffect={glitchEffect}
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
  readonly glitchEffect: EventGlitchEffect;
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
  glitchEffect,
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
    if (!effectsRef.current.ca || !effectsRef.current.noise || !effectsRef.current.scanline) {
      if (composer) {
        resolveMutableEffects(composer, effectsRef.current);
      }
    }

    // glitch state を lazy init
    if (!glitchState.current) {
      glitchState.current = createGlitchState(t, glitchControls);
    }

    const lanternRaw = computeLanternFlicker(t, flickerParams);
    const output = updateGlitches(t, lanternRaw, glitchState.current, glitchControls);

    const { ca, noise, scanline } = effectsRef.current;
    const briefIntensity = clamp01(output.briefIntensity);
    const heavyIntensity = clamp01(output.heavyIntensity);

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

    // --- Block / tracking distortion ---
    const blockIntensity = clamp01(
      briefIntensity * glitchControls.briefBlockStrength +
        heavyIntensity * glitchControls.heavyBlockStrength,
    );
    glitchEffect.updateUniforms(
      t,
      blockIntensity,
      glitchControls.blockColumns * (1 + heavyIntensity),
    );
  });

  return null;
}

interface MutablePostEffects {
  ca: ChromaticAberrationEffect | null;
  noise: NoiseEffect | null;
  scanline: ScanlineEffect | null;
}

interface ComposerWithPasses {
  readonly passes: readonly unknown[];
}

function resolveMutableEffects(composer: ComposerWithPasses, effectsRef: MutablePostEffects): void {
  for (const pass of composer.passes) {
    const effects = getPassEffects(pass);
    if (!effects) continue;
    for (const effect of effects) {
      if (
        effectsRef.ca === null &&
        isEffectNamed<ChromaticAberrationEffect>(effect, "ChromaticAberrationEffect")
      ) {
        effectsRef.ca = effect;
      } else if (effectsRef.noise === null && isEffectNamed<NoiseEffect>(effect, "NoiseEffect")) {
        effectsRef.noise = effect;
      } else if (
        effectsRef.scanline === null &&
        isEffectNamed<ScanlineEffect>(effect, "ScanlineEffect")
      ) {
        effectsRef.scanline = effect;
      }
    }
  }
}

function getPassEffects(pass: unknown): Iterable<unknown> | null {
  if (!(pass instanceof EffectPass) && getConstructorName(pass) !== "EffectPass") {
    return null;
  }

  const effects = (pass as { effects?: unknown }).effects;
  return isIterable(effects) ? effects : null;
}

function isEffectNamed<T>(effect: unknown, name: string): effect is T {
  return getConstructorName(effect) === name;
}

function getConstructorName(value: unknown): string | undefined {
  return (value as { constructor?: { name?: string } } | null)?.constructor?.name;
}

function isIterable(value: unknown): value is Iterable<unknown> {
  return typeof (value as { [Symbol.iterator]?: unknown } | null)?.[Symbol.iterator] === "function";
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

const EVENT_GLITCH_FRAGMENT_SHADER = /* glsl */ `
  uniform float intensity;
  uniform float glitchTime;
  uniform float columns;

  float eventGlitchHash(float n) {
    return fract(sin(n) * 43758.5453123);
  }

  void mainUv(inout vec2 uv) {
    float amount = clamp(intensity, 0.0, 1.0);
    if (amount <= 0.001) {
      return;
    }

    float tick = floor(glitchTime * 36.0);
    float bandCount = mix(18.0, 52.0, amount);
    float band = floor((uv.y + glitchTime * 4.0) * bandCount);
    float bandHash = eventGlitchHash(band + tick * 13.17);
    float bandMask = step(0.58, bandHash + amount * 0.35);
    float bandDir = mix(-1.0, 1.0, step(0.5, eventGlitchHash(band * 7.13 + tick)));
    float bandShift =
      bandDir * bandMask * (0.012 + amount * 0.08) * eventGlitchHash(band * 3.77 + tick * 0.31);

    float cellX = floor(uv.x / max(columns, 0.005));
    float blockHash = eventGlitchHash(cellX * 2.31 + band * 19.17 + tick);
    float blockMask = step(0.75, blockHash + amount * 0.2);
    uv.x = fract(uv.x + bandShift + blockMask * bandDir * amount * 0.045);
  }

  void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
    float amount = clamp(intensity, 0.0, 1.0);
    float tick = floor(glitchTime * 48.0);
    float lineMask = step(0.92, eventGlitchHash(floor(uv.y * 180.0) + tick) + amount * 0.14);
    float dropoutMask =
      step(0.96, eventGlitchHash(floor(uv.y * 52.0) + tick * 2.71) + amount * 0.22);

    vec3 color = inputColor.rgb;
    color += lineMask * amount * vec3(0.22, 0.28, 0.32);
    color *= 1.0 - dropoutMask * amount * 0.55;
    outputColor = vec4(color, inputColor.a);
  }
`;

class EventGlitchEffect extends Effect {
  constructor() {
    super("EventGlitchEffect", EVENT_GLITCH_FRAGMENT_SHADER, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform<number>>([
        ["intensity", new Uniform(0)],
        ["glitchTime", new Uniform(0)],
        ["columns", new Uniform(DEFAULT_GLITCH_PARAMS.blockColumns)],
      ]),
    });
  }

  updateUniforms(time: number, intensity: number, columns: number): void {
    setEffectUniform(this, "glitchTime", time);
    setEffectUniform(this, "intensity", intensity);
    setEffectUniform(this, "columns", columns);
  }
}

function setEffectUniform(effect: Effect, key: string, value: number): void {
  const uniform = effect.uniforms.get(key);
  if (uniform) uniform.value = value;
}
