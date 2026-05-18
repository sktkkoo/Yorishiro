/**
 * CharacterSurface — Three/VRM/Scene viewport の host mount node。
 *
 * 旧構造では .sidebar の子（.charactor-container）だったが、shell named-surfaces
 * P1 で .shell-column wrapper 直下・chrome .sidebar の兄弟へ引き上げた。mount 時に
 * surface registry へ "character" として自己登録する（querySelector を廃する）。
 * ThreeRuntime は singleton canvas を attachTo で re-parent するので、この
 * コンポーネントの再 mount は canvas/WebGL/VRM を破棄しない。
 *
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §2/§5-P1
 */

import { lazy, Suspense, useEffect, useRef } from "react";
import type { Body } from "./core/body";
import type { SubsystemLog } from "./core/dev-log";
import { SceneRouter } from "./core/scene";
import type { ScenePackEntry } from "./runtime/scene-pack-registry/types";
import { getSurfaceRegistry } from "./runtime/surface-registry";

const VrmViewer = lazy(() => import("./vrm-viewer"));

interface CharacterSurfaceProps {
  readonly vrmUrl: string | null;
  readonly onBodyReady?: (body: Body | null) => void;
  readonly bodyDevLog?: SubsystemLog;
  readonly scene: ScenePackEntry | null;
}

export default function CharacterSurface({
  vrmUrl,
  onBodyReady,
  bodyDevLog,
  scene,
}: CharacterSurfaceProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // NOTE: React StrictMode の effect 二重実行は cleanup→re-register の順で進み、
  // 同一 el identity なので unregister が中間で外しても直後の register が復元する。
  // 最終状態は常に登録済み。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const reg = getSurfaceRegistry();
    reg.register("character", el);
    return () => reg.unregister("character", el);
  }, []);

  const vrmContent = vrmUrl ? (
    <Suspense fallback={<div className="vrm-loading" />}>
      <VrmViewer url={vrmUrl} onBodyReady={onBodyReady} devLog={bodyDevLog} />
    </Suspense>
  ) : (
    <div className="vrm-placeholder" />
  );

  return (
    /* クラス名は既存 CSS 一致のため意図的な表記（typo 由来。改名時は App.css も同時に） */
    <div className="charactor-container" ref={containerRef}>
      <SceneRouter entry={scene}>{vrmContent}</SceneRouter>
    </div>
  );
}
