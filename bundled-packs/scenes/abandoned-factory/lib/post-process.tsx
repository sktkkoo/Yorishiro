/**
 * abandoned-factory の post-process pipeline.
 *
 * spec §8.1 の 9 layer を @react-three/postprocessing の標準 effect で
 * simplified 実装. custom Effect (cool grade / warm halation / tracking
 * wobble) は Phase 7 polish に deferred.
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
import { BlendFunction, ToneMappingMode } from "postprocessing";
import { Vector2 } from "three";

/** ChromaticAberration の offset は Vector2 を要求する */
const CA_OFFSET = /* @__PURE__ */ new Vector2(0.0008, 0.0012);

/**
 * always-on の α+β post-process layer.
 *
 * ToneMapping (ACES Filmic) → Bloom → ChromaticAberration → Noise →
 * Scanline → Vignette の順で適用。
 */
export function AbandonedFactoryPostProcess() {
  return (
    <EffectComposer multisampling={0}>
      <ToneMapping mode={ToneMappingMode.ACES_FILMIC} />
      <Bloom intensity={0.6} luminanceThreshold={0.5} luminanceSmoothing={0.4} mipmapBlur />
      <ChromaticAberration offset={CA_OFFSET} radialModulation={true} modulationOffset={0.5} />
      <Noise opacity={0.06} blendFunction={BlendFunction.MULTIPLY} />
      <Scanline density={1.25} opacity={0.05} />
      <Vignette offset={0.3} darkness={0.7} />
    </EffectComposer>
  );
}
