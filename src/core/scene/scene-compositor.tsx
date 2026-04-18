// src/core/scene/scene-compositor.tsx

import type { CSSProperties, ReactNode } from "react";
import type { Layer, SceneSpec } from "./types";

/**
 * Scene Compositor — layer stack を DOM で描画する薄い component。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「住まうということ」
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md §5
 *
 * 責務:
 *   - scene.layers を stacking order で <div> として描画。scene.layers の**先頭が一番奥**、
 *     末尾が一番手前。各 layer は `position: absolute; inset: 0` で親を覆い、後続 sibling が
 *     DOM 順で上に重なる。
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
  return /\.(webm|mp4|mov|m4v|ogv)$/i.test(src);
}

/**
 * Layer -> inline style の pure 関数。test 対象。
 * export しておき scene-compositor.test.ts から import する。
 */
export function layerStyle(layer: Layer): CSSProperties {
  const style: CSSProperties = { ...layerBaseStyle };
  if (typeof layer.blur === "number") {
    style.filter = `blur(${layer.blur}px)`;
  }
  if (layer.backgroundColor !== undefined) {
    style.backgroundColor = layer.backgroundColor;
  }
  if (layer.backgroundImage !== undefined) {
    style.backgroundImage = layer.backgroundImage;
  }
  return style;
}

export function SceneCompositor({ scene, children }: SceneCompositorProps) {
  return (
    <div className="scene-compositor" style={containerStyle}>
      {scene.layers.map((layer) => (
        <div key={layer.id} data-layer-id={layer.id} style={layerStyle(layer)}>
          {layer.src !== undefined ? (
            isVideoSrc(layer.src) ? (
              <video src={layer.src} autoPlay muted loop playsInline style={coverStyle} />
            ) : (
              <img src={layer.src} alt="" style={coverStyle} />
            )
          ) : null}
          {layer.role === "character" ? children : null}
        </div>
      ))}
    </div>
  );
}
