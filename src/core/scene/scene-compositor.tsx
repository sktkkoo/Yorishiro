// src/core/scene/scene-compositor.tsx

import type { CSSProperties, ReactNode } from "react";
import { ProceduralSceneLayer } from "./procedural-scene-layer";
import type { Layer, SceneSpec } from "./types";

/**
 * Scene Compositor — layer stack を DOM で描画する薄い component。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「UI は環境である」
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md §5
 *
 * 責務:
 *   - scene.layers を stacking order で <div> として描画。scene.layers の**先頭が一番奥**、
 *     末尾が一番手前。各 layer は `position: absolute; inset: 0` で親を覆い、後続 sibling が
 *     DOM 順で上に重なる。
 *   - role="foreground" は前景の意味を優先し、ThreeRuntime が body 直下に置く character
 *     canvas より前に来るよう positive z-index を持つ。
 *   - per-layer の blur / backgroundColor / backgroundImage を inline style で apply
 *   - layer.src が set されていれば <img> or <video> を挿入（拡張子から判定）
 *   - role="character" の layer に children を埋める（= VRM の slot）
 *
 * 非責務:
 *   - VRM の生成 / lifecycle（ThreeRuntime singleton が所有）
 *   - pack の load / manifest parse（Phase 2）
 *   - ambient binding の評価（Phase 3）
 *   - asset の load state / error handling（本 MVP は放置、必要なら Phase 2 で拾う）
 */
export interface SceneCompositorProps {
  readonly scene: SceneSpec;
  /** character role layer に差し込まれる slot content (= VrmViewer 等) */
  readonly children?: ReactNode;
}

const containerStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
};

const layerBaseStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
};

const foregroundLayerZIndex = 1;

const coverStyle: CSSProperties = {
  width: "100%",
  height: "100%",
  objectFit: "cover",
  objectPosition: "center",
  display: "block",
};

/**
 * 動画拡張子かを判定する pure 関数。
 * .webm / .mp4 / .mov / .m4v / .ogv を動画とみなす（case-insensitive）。
 * query string は reject（regex が $ でアンカーするため）。
 */
export function isVideoSrc(src: string): boolean {
  return /^data:video\//i.test(src) || /\.(webm|mp4|mov|m4v|ogv)$/i.test(src);
}

export function isVideoLayer(layer: Layer): boolean {
  if (layer.mediaType !== undefined) return layer.mediaType === "video";
  return layer.src !== undefined && isVideoSrc(layer.src);
}

export function isProceduralLayer(layer: Layer): boolean {
  return layer.procedural !== undefined;
}

/**
 * Layer -> inline style の pure 関数。test 対象。
 * export しておき scene-compositor.test.ts から import する。
 */
export function layerStyle(layer: Layer): CSSProperties {
  const style: CSSProperties = { ...layerBaseStyle };
  if (layer.role === "foreground") {
    style.zIndex = foregroundLayerZIndex;
  }
  const filters: string[] = [];
  if (typeof layer.blur === "number") {
    filters.push(`blur(${layer.blur}px)`);
  }
  if (layer.dropShadow !== undefined) {
    const shadow = layer.dropShadow;
    filters.push(
      `drop-shadow(${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.color})`,
    );
  }
  if (filters.length > 0) {
    style.filter = filters.join(" ");
  }
  if (typeof layer.opacity === "number") {
    style.opacity = layer.opacity;
  }
  if (layer.backgroundColor !== undefined) {
    style.backgroundColor = layer.backgroundColor;
  }
  if (layer.backgroundImage !== undefined) {
    style.backgroundImage = layer.backgroundImage;
  }
  return style;
}

/**
 * media（img / video）要素の inline style を作る pure 関数。test 対象。
 * coverStyle をベースに、layer の offset/scale/rotation から CSS transform を組む。
 * 値が全て省略されていれば transform は付けない（= 既存挙動と完全に一致）。
 */
export function mediaStyle(layer: Layer): CSSProperties {
  const transforms: string[] = [];
  const { mediaOffsetX, mediaOffsetY } = layer;
  if (typeof mediaOffsetX === "number" || typeof mediaOffsetY === "number") {
    transforms.push(`translate(${mediaOffsetX ?? 0}%, ${mediaOffsetY ?? 0}%)`);
  }
  if (typeof layer.mediaScale === "number") {
    transforms.push(`scale(${layer.mediaScale})`);
  }
  if (typeof layer.mediaRotation === "number") {
    transforms.push(`rotate(${layer.mediaRotation}deg)`);
  }
  if (transforms.length === 0) return coverStyle;
  return { ...coverStyle, transform: transforms.join(" ") };
}

export function SceneCompositor({ scene, children }: SceneCompositorProps) {
  return (
    <div className="scene-compositor" style={containerStyle}>
      {scene.layers.map((layer) => (
        <div key={layer.id} data-layer-id={layer.id} style={layerStyle(layer)}>
          {layer.procedural !== undefined ? (
            <ProceduralSceneLayer procedural={layer.procedural} />
          ) : null}
          {layer.src !== undefined ? (
            isVideoLayer(layer) ? (
              <video src={layer.src} autoPlay muted loop playsInline style={mediaStyle(layer)} />
            ) : (
              <img src={layer.src} alt="" style={mediaStyle(layer)} />
            )
          ) : null}
          {layer.role === "character" ? children : null}
        </div>
      ))}
    </div>
  );
}
