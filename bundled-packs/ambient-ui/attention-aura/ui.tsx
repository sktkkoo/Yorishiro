/**
 * @charminal/bundled-packs/ambient-ui/attention-aura
 *
 * Attention runtime の snapshot を subscribe し、target rect を淡い光の帯で
 * overlay する bundled ambient-ui pack。
 *
 * 設計の核:
 * - target=null かつ opacity=0 で **RAF を完全停止** (Phase 1a 設計判断)
 * - lerp 収束 (rect 0.5px / opacity 0.005 以下の差) で RAF pause
 * - `mixBlendMode: "screen"` + `filter: blur(px)` で加算 glow を実現 (v1 復元)
 * - container を spread 込みで拡張: left: x-spread, width: rect.width+spread*2
 * - opacity 変化は CSS `transition: opacity` で compositor 任せ
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
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { type AuraView, fadeOutOpacity, isConverged, lerpView } from "./lerp";
import { type AuraVisualStyle, auraVisualForTarget, targetOpacity } from "./visual";

const LERP_SPEED = 10;
const FADE_OUT_DURATION_S = 3.2;
const HIDE_OPACITY = 0.002;

interface AuraComponentProps {
  readonly ctx: AmbientUiContext;
}

function Aura({ ctx }: AuraComponentProps): React.JSX.Element | null {
  const [view, setView] = useState<AuraView>({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });
  const targetRef = useRef<AttentionTarget | null>(ctx.attention.get().target);
  const fadeStateRef = useRef<{ startOpacity: number; elapsedS: number } | null>(null);
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  // RAF tick
  const tick = (now: number): void => {
    const delta = Math.max(0, Math.min(0.05, (now - lastTimeRef.current) / 1000));
    lastTimeRef.current = now;
    const t = Math.min(1, LERP_SPEED * delta);
    const target = targetRef.current;

    setView((current) => {
      if (target === null) {
        // --- fade-out フェーズ ---
        // elapsedS が FADE_OUT_DURATION_S に達するまで RAF を継続し、
        // opacity を滑らかに減衰させる。lerp 収束チェックは行わない。
        // (lerp 収束で止めると nextTargetView.opacity ≈ current.opacity になった
        //  瞬間に isConverged が true になり、fade 初フレームで RAF が止まって
        //  opacity が 0 に即スナップする bug を防ぐため)
        let fade = fadeStateRef.current;
        if (fade === null) {
          fade = { startOpacity: current.opacity, elapsedS: 0 };
          fadeStateRef.current = fade;
        }
        const updated = { startOpacity: fade.startOpacity, elapsedS: fade.elapsedS + delta };
        fadeStateRef.current = updated;

        // duration 到達 → RAF 停止し opacity を 0 確定
        if (updated.elapsedS >= FADE_OUT_DURATION_S) {
          if (rafRef.current !== null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
          }
          fadeStateRef.current = null;
          return { ...current, opacity: 0 };
        }

        // duration 未到達 → opacity を減衰させて RAF 継続
        const opacity = fadeOutOpacity(updated, FADE_OUT_DURATION_S);
        rafRef.current = requestAnimationFrame(tick);
        return { ...current, opacity };
      }

      // --- target 追従フェーズ ---
      fadeStateRef.current = null;
      const desiredOpacity = targetOpacity(target);
      const nextTargetView: AuraView = {
        x: target.rect.x,
        y: target.rect.y,
        width: target.rect.width,
        height: target.rect.height,
        opacity: desiredOpacity,
      };
      const next = lerpView(current, nextTargetView, t);

      // lerp 収束したら RAF を pause (Phase 1a 設計判断: target が静止している間は
      // RAF を止めてバッテリー / CPU 負荷を下げる。target 変化で subscribe から再起動)
      if (isConverged(next, nextTargetView)) {
        if (rafRef.current !== null) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = null;
        }
        return nextTargetView;
      }

      // RAF 継続
      rafRef.current = requestAnimationFrame(tick);
      return next;
    });
  };

  const startRaf = (): void => {
    if (rafRef.current !== null) return;
    lastTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  };

  // subscribe / unsubscribe + RAF 起動 trigger
  // biome-ignore lint/correctness/useExhaustiveDependencies: startRaf/tick は ref のみ参照する安定関数。再生成不要
  useEffect(() => {
    const sub = ctx.attention.subscribe((snapshot) => {
      targetRef.current = snapshot.target;
      // target 変化で RAF を必ず再起動 (止まってたら起動)
      startRaf();
    });
    return () => {
      sub.dispose();
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [ctx]);

  if (view.opacity <= HIDE_OPACITY && targetRef.current === null) return null;

  const visual: AuraVisualStyle = auraVisualForTarget({
    kind: targetRef.current?.kind ?? "mouse",
    reason: targetRef.current?.reason,
    width: view.width,
    height: view.height,
  });

  return (
    <div
      aria-hidden="true"
      data-testid="attention-aura-overlay"
      style={{
        position: "fixed",
        left: view.x - visual.spread,
        top: view.y - visual.spread,
        width: view.width + visual.spread * 2,
        height: view.height + visual.spread * 2,
        opacity: view.opacity,
        pointerEvents: "none",
        borderRadius: visual.borderRadius,
        background: visual.background,
        boxShadow: visual.boxShadow,
        filter: `blur(${visual.blur}px)`,
        mixBlendMode: "screen",
        transition: "opacity 220ms linear",
        transform: "translateZ(0)",
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
      // React Strict Mode の double-mount cleanup で sync unmount すると
      // 「Attempted to synchronously unmount a root while React was already
      // rendering」が出るため microtask に defer する。
      dispose: () => queueMicrotask(() => root.unmount()),
    };
  },
} satisfies AmbientUiPackDefinition;

export default attentionAuraPack;
export { Aura, FADE_OUT_DURATION_S, HIDE_OPACITY, LERP_SPEED };
