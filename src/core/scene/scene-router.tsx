/**
 * SceneRouter — active scene pack の component 有無で DOM 側の振り分けを行う。
 *
 * 3 つの path:
 * 1. component あり + layers 空: R3F-only path。DOM は最小 wrapper のみ。
 *    (例: abandoned-factory, simple-room)
 * 2. component あり + layers 非空: hybrid path。SceneCompositor で DOM layers を
 *    描画しつつ、R3fRuntimeRoot が component を R3F canvas 内に mount。
 *    (例: misty-grasslands — procedural 背景は別 canvas、lighting は R3F 経由)
 * 3. component なし: 従来の declarative path。SceneCompositor のみ。
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
  if (entry?.component && entry.scene.layers.length > 0) {
    return (
      <SceneCompositor key={entry.id} scene={entry.scene}>
        {children}
      </SceneCompositor>
    );
  }
  if (entry?.component) {
    return (
      <div className="scene-r3f-host" style={r3fHostStyle}>
        {children}
      </div>
    );
  }
  if (entry?.scene) {
    return (
      <SceneCompositor key={entry.id} scene={entry.scene}>
        {children}
      </SceneCompositor>
    );
  }
  return <>{children}</>;
}
