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
 *   - scene.layers を stacking order で <div> として描画
 *   - per-layer の blur / backgroundColor / backgroundImage を inline style で apply
 *   - role="character" の layer に children を埋める（= VRM の slot）
 *
 * 非責務:
 *   - VRM の生成 / lifecycle（ThreeRuntime singleton が所有）
 *   - pack の load / manifest parse（Phase 2）
 *   - ambient binding の評価（Phase 3）
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

export function SceneCompositor({ scene, children }: SceneCompositorProps): JSX.Element {
  return (
    <div className="scene-compositor" style={containerStyle}>
      {scene.layers.map((layer) => (
        <div key={layer.id} data-layer-id={layer.id} style={layerStyle(layer)}>
          {layer.role === "character" ? children : null}
        </div>
      ))}
    </div>
  );
}
