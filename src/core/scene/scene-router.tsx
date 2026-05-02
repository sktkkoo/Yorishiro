/**
 * SceneRouter — active scene pack の component 有無で DOM 側の振り分けを行う。
 *
 * - entry に component あり: R3F-component path。DOM 側は最小 wrapper のみで、
 *   実際の 3D render は R3F (R3fRuntimeRoot) が registry を subscribe して mount。
 * - entry に component なし: 従来の declarative path。SceneCompositor で
 *   layers を DOM stack 描画。
 * - entry が null: children だけを通す。
 *
 * VRM canvas (children) はどの path でも `.scene-r3f-host` 内 / SceneCompositor の
 * character role layer 内 / 直接親の中、のいずれかに置かれる。ThreeRuntime は
 * 同じ canvas singleton なので path に依存しない。
 *
 * Internal design-record: specs/2026-05-03-scene-pack-r3f-component.md §4
 */

import type { CSSProperties, ReactNode } from "react";
import type { ScenePackEntry } from "../../runtime/scene-pack-registry/types";
import { SceneCompositor } from "./scene-compositor";

export interface SceneRouterProps {
  readonly entry: ScenePackEntry | null;
  readonly children: ReactNode;
}

const r3fHostStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
};

export function SceneRouter({ entry, children }: SceneRouterProps) {
  if (entry?.component) {
    return (
      <div className="scene-r3f-host" style={r3fHostStyle}>
        {children}
      </div>
    );
  }
  if (entry?.scene) {
    return <SceneCompositor scene={entry.scene}>{children}</SceneCompositor>;
  }
  return <>{children}</>;
}
