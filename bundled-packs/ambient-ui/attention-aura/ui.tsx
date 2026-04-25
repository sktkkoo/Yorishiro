/**
 * @charminal/bundled-packs/ambient-ui/attention-aura
 *
 * Attention runtime の snapshot を subscribe し、target rect を淡い光の帯で
 * overlay する bundled ambient-ui pack。
 *
 * 設計の核:
 * - target=null かつ opacity=0 で **RAF を完全停止** (Phase 1a 設計判断)
 * - lerp 収束 (rect 0.5px / opacity 0.005 以下の差) で RAF pause
 * - rect 補間は `transform: translate + scale` で GPU layer に乗せる
 * - opacity 変化は CSS `transition: opacity` で compositor 任せ
 * - filter: blur は使わず box-shadow blur radius + radial-gradient で glow
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 *   「Aura 描画負荷の対策」section
 */

import type {
  AmbientUiContext,
  AmbientUiPackDefinition,
  AttentionTarget,
  Disposable,
} from "@charminal/sdk";
import type React from "react";
import { useEffect, useState } from "react";
import ReactDOM from "react-dom/client";
import type { AuraView } from "./lerp";
import { auraVisualForTarget } from "./visual";

const LERP_SPEED = 10;
const FADE_OUT_DURATION_S = 3.2;
const HIDE_OPACITY = 0.002;

interface AuraComponentProps {
  readonly ctx: AmbientUiContext;
}

function Aura({ ctx }: AuraComponentProps): React.JSX.Element | null {
  // _setView は Task 5 の RAF loop で使う（skeleton 段階では未呼び出し）
  const [view, _setView] = useState<AuraView>({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });
  const [target, setTarget] = useState<AttentionTarget | null>(() => ctx.attention.get().target);

  // subscribe / unsubscribe
  useEffect(() => {
    const sub = ctx.attention.subscribe((snapshot) => {
      setTarget(snapshot.target);
    });
    return () => sub.dispose();
  }, [ctx]);

  if (view.opacity <= HIDE_OPACITY && target === null) return null;

  const visual = auraVisualForTarget({
    kind: target?.kind ?? "mouse",
    reason: target?.reason,
    width: view.width,
    height: view.height,
  });

  return (
    <div
      aria-hidden="true"
      style={{
        position: "fixed",
        left: view.x,
        top: view.y,
        width: view.width,
        height: view.height,
        opacity: view.opacity,
        pointerEvents: "none",
        borderRadius: visual.borderRadius,
        background: visual.background,
        boxShadow: visual.boxShadow,
        transition: "opacity 220ms linear",
        // transform: translate3d で GPU layer 化 (Task 5 で実装)
        transform: "translateZ(0)",
        zIndex: 100,
      }}
    />
  );
}

const attentionAuraPack = {
  type: "ambient-ui",
  id: "attention-aura",
  mount: (ctx: AmbientUiContext, container: HTMLDivElement): Disposable => {
    const root = ReactDOM.createRoot(container);
    root.render(<Aura ctx={ctx} />);
    return {
      dispose: () => root.unmount(),
    };
  },
} satisfies AmbientUiPackDefinition;

export default attentionAuraPack;
export { Aura, FADE_OUT_DURATION_S, HIDE_OPACITY, LERP_SPEED };
