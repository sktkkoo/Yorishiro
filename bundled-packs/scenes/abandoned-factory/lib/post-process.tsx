/**
 * abandoned-factory の post-process pipeline.
 *
 * spec §8.1 の 9 layer を @react-three/postprocessing の標準 effect で
 * simplified 実装. custom Effect (cool grade / warm halation / tracking
 * wobble) は Phase 7 polish に deferred.
 *
 * leva controls (folder "abandoned-factory > post"):
 *   各 effect の主要パラメータを runtime 調整可能.
 */

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
import { Vector2 } from "three";

/**
 * always-on の α+β post-process layer.
 *
 * ToneMapping (ACES Filmic) → Bloom → ChromaticAberration → Noise →
 * Scanline → Vignette の順で適用.
 *
 * 各 effect は leva で intensity / threshold / opacity を runtime 調整可能.
 */
export function AbandonedFactoryPostProcess() {
  const { bloomIntensity, bloomThreshold, bloomSmoothing } = useControls("abandoned-factory", {
    bloom: folder({
      bloomIntensity: { value: 0.85, min: 0, max: 3, step: 0.05 },
      bloomThreshold: { value: 0.2, min: 0, max: 1, step: 0.01 },
      bloomSmoothing: { value: 0.5, min: 0, max: 1, step: 0.01 },
    }),
  });

  const { caOffsetX, caOffsetY } = useControls("abandoned-factory", {
    chromaticAberration: folder(
      {
        caOffsetX: { value: 0.0059, min: 0, max: 0.01, step: 0.0001 },
        caOffsetY: { value: 0.0059, min: 0, max: 0.01, step: 0.0001 },
      },
      { collapsed: true },
    ),
  });

  const { noiseOpacity } = useControls("abandoned-factory", {
    noise: folder(
      {
        noiseOpacity: { value: 0.2, min: 0, max: 0.3, step: 0.005 },
      },
      { collapsed: true },
    ),
  });

  const { scanlineDensity, scanlineOpacity } = useControls("abandoned-factory", {
    scanline: folder(
      {
        scanlineDensity: { value: 0.8, min: 0.5, max: 5, step: 0.05 },
        scanlineOpacity: { value: 0.02, min: 0, max: 0.5, step: 0.01 },
      },
      { collapsed: true },
    ),
  });

  const { vignetteOffset, vignetteDarkness } = useControls("abandoned-factory", {
    vignette: folder({
      vignetteOffset: { value: 0.03, min: 0, max: 1, step: 0.01 },
      vignetteDarkness: { value: 0.8, min: 0, max: 2, step: 0.01 },
    }),
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
        offset={new Vector2(caOffsetX, caOffsetY)}
        radialModulation={true}
        modulationOffset={0.5}
      />
      <Noise opacity={noiseOpacity} blendFunction={BlendFunction.MULTIPLY} />
      <Scanline density={scanlineDensity} opacity={scanlineOpacity} />
      <Vignette offset={vignetteOffset} darkness={vignetteDarkness} />
    </EffectComposer>
  );
}
