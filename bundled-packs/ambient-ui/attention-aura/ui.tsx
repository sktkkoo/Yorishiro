/**
 * @yorishiro/bundled-packs/ambient-ui/attention-aura
 *
 * Attention runtime の snapshot を subscribe し、target rect を淡い光の帯で
 * overlay する bundled ambient-ui pack。
 *
 * 設計の核:
 * - target=null かつ opacity=0 で **RAF を完全停止** (Phase 1a 設計判断)
 * - lerp 収束 (rect 0.5px / opacity 0.005 以下の差) で RAF pause
 * - `mixBlendMode: "screen"` + `filter: blur(px)` で加算 glow を実現 (v1 復元)
 * - container を spread 込みで拡張: left: x-spread, width: rect.width+spread*2
 * - rAF 中は React state を更新せず DOM style を直接更新する
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 *   「Aura 描画負荷の対策」section
 */

import type {
  AmbientUiContext,
  AmbientUiPackDefinition,
  AttentionTarget,
  Disposable,
} from "@yorishiro/sdk";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { type AuraView, fadeOutOpacity, isConverged, lerp } from "./lerp";
import {
  type AuraVisualStyle,
  auraBorderRadiusForTarget,
  auraVisualForTarget,
  targetOpacity,
} from "./visual";

const LERP_SPEED = 10;
const FADE_OUT_DURATION_S = 3.2;
const HIDE_OPACITY = 0.002;

interface AuraComponentProps {
  readonly ctx: AmbientUiContext;
}

type MutableAuraView = {
  -readonly [K in keyof AuraView]: AuraView[K];
};

type MutableAuraVisualStyle = {
  -readonly [K in keyof AuraVisualStyle]: AuraVisualStyle[K];
};

function Aura({ ctx }: AuraComponentProps): React.JSX.Element | null {
  const initialTarget = ctx.attention.get().target;
  const [mountedState, setMountedState] = useState(() => initialTarget !== null);
  const mountedRef = useRef(mountedState);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<MutableAuraView>({ x: 0, y: 0, width: 0, height: 0, opacity: 0 });
  const targetViewRef = useRef<MutableAuraView>(targetToView(initialTarget));
  const visualRef = useRef<MutableAuraVisualStyle>(
    mutableVisualForTarget(initialTarget, targetViewRef.current),
  );
  const targetRef = useRef<AttentionTarget | null>(initialTarget);
  const fadeStateRef = useRef({ active: false, startOpacity: 0, elapsedS: 0 });
  const rafRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);

  const setMounted = (next: boolean): void => {
    if (mountedRef.current === next) return;
    mountedRef.current = next;
    setMountedState(next);
  };

  const updateBorderRadius = (): void => {
    const target = targetRef.current;
    const view = viewRef.current;
    visualRef.current.borderRadius = auraBorderRadiusForTarget({
      kind: target?.kind ?? "mouse",
      reason: target?.reason,
      width: view.width,
      height: view.height,
    });
  };

  const applyView = (): void => {
    const el = overlayRef.current;
    if (el === null) return;
    const view = viewRef.current;
    const visual = visualRef.current;
    el.style.left = `${view.x - visual.spread}px`;
    el.style.top = `${view.y - visual.spread}px`;
    el.style.width = `${view.width + visual.spread * 2}px`;
    el.style.height = `${view.height + visual.spread * 2}px`;
    el.style.opacity = String(view.opacity);
    el.style.borderRadius = `${visual.borderRadius}px`;
    el.style.background = visual.background;
    el.style.boxShadow = visual.boxShadow;
    el.style.filter = `blur(${visual.blur}px)`;
  };

  const stopRaf = (): void => {
    if (rafRef.current === null) return;
    cancelAnimationFrame(rafRef.current);
    rafRef.current = null;
  };

  // RAF tick
  const tick = (now: number): void => {
    const delta = Math.max(0, Math.min(0.05, (now - lastTimeRef.current) / 1000));
    lastTimeRef.current = now;
    const t = Math.min(1, LERP_SPEED * delta);
    const target = targetRef.current;
    const view = viewRef.current;

    if (target === null) {
      // --- fade-out フェーズ ---
      // elapsedS が FADE_OUT_DURATION_S に達するまで RAF を継続し、
      // opacity を滑らかに減衰させる。lerp 収束チェックは行わない。
      if (view.opacity <= HIDE_OPACITY) {
        view.opacity = 0;
        fadeStateRef.current.active = false;
        applyView();
        stopRaf();
        setMounted(false);
        return;
      }
      const fade = fadeStateRef.current;
      if (!fade.active) {
        fade.active = true;
        fade.startOpacity = view.opacity;
        fade.elapsedS = 0;
      }
      fade.elapsedS += delta;

      // duration 到達 → RAF 停止し opacity を 0 確定
      if (fade.elapsedS >= FADE_OUT_DURATION_S) {
        view.opacity = 0;
        fade.active = false;
        applyView();
        stopRaf();
        setMounted(false);
        return;
      }

      // duration 未到達 → opacity を減衰させて RAF 継続
      view.opacity = fadeOutOpacity(fade, FADE_OUT_DURATION_S);
      applyView();
      rafRef.current = requestAnimationFrame(tick);
      return;
    }

    // --- target 追従フェーズ ---
    fadeStateRef.current.active = false;
    const nextTargetView = targetViewRef.current;
    view.x = lerp(view.x, nextTargetView.x, t);
    view.y = lerp(view.y, nextTargetView.y, t);
    view.width = lerp(view.width, nextTargetView.width, t);
    view.height = lerp(view.height, nextTargetView.height, t);
    view.opacity = lerp(view.opacity, nextTargetView.opacity, t);
    updateBorderRadius();

    // lerp 収束したら RAF を pause (Phase 1a 設計判断: target が静止している間は
    // RAF を止めてバッテリー / CPU 負荷を下げる。target 変化で subscribe から再起動)
    if (isConverged(view, nextTargetView)) {
      view.x = nextTargetView.x;
      view.y = nextTargetView.y;
      view.width = nextTargetView.width;
      view.height = nextTargetView.height;
      view.opacity = nextTargetView.opacity;
      updateBorderRadius();
      applyView();
      stopRaf();
      return;
    }

    // RAF 継続
    applyView();
    rafRef.current = requestAnimationFrame(tick);
  };

  const setTarget = (target: AttentionTarget | null): void => {
    targetRef.current = target;
    if (target !== null) {
      const next = targetViewRef.current;
      next.x = target.rect.x;
      next.y = target.rect.y;
      next.width = target.rect.width;
      next.height = target.rect.height;
      next.opacity = targetOpacity(target);
      visualRef.current = mutableVisualForTarget(target, next);
      setMounted(true);
      return;
    }

    visualRef.current = mutableVisualForTarget(null, viewRef.current);
    if (viewRef.current.opacity <= HIDE_OPACITY) {
      viewRef.current.opacity = 0;
      fadeStateRef.current.active = false;
      stopRaf();
      setMounted(false);
    }
  };

  const startRaf = (): void => {
    if (rafRef.current !== null) return;
    if (targetRef.current === null && viewRef.current.opacity <= HIDE_OPACITY) {
      viewRef.current.opacity = 0;
      fadeStateRef.current.active = false;
      setMounted(false);
      return;
    }
    lastTimeRef.current = performance.now();
    rafRef.current = requestAnimationFrame(tick);
  };

  // subscribe / unsubscribe + RAF 起動 trigger
  // biome-ignore lint/correctness/useExhaustiveDependencies: startRaf/tick は ref のみ参照する安定関数。再生成不要
  useEffect(() => {
    const sub = ctx.attention.subscribe((snapshot) => {
      setTarget(snapshot.target);
      // target 変化で RAF を必ず再起動 (止まってたら起動)
      startRaf();
    });
    return () => {
      sub.dispose();
      stopRaf();
    };
  }, [ctx]);

  useEffect(() => {
    applyView();
  });

  if (!mountedState) return null;

  const view = viewRef.current;
  const visual = visualRef.current;

  return (
    <div
      ref={overlayRef}
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

function targetToView(target: AttentionTarget | null): MutableAuraView {
  if (target === null) {
    return { x: 0, y: 0, width: 0, height: 0, opacity: 0 };
  }
  return {
    x: target.rect.x,
    y: target.rect.y,
    width: target.rect.width,
    height: target.rect.height,
    opacity: targetOpacity(target),
  };
}

function mutableVisualForTarget(
  target: AttentionTarget | null,
  view: AuraView,
): MutableAuraVisualStyle {
  const visual = auraVisualForTarget({
    kind: target?.kind ?? "mouse",
    reason: target?.reason,
    width: view.width,
    height: view.height,
  });
  return {
    blur: visual.blur,
    spread: visual.spread,
    borderRadius: visual.borderRadius,
    background: visual.background,
    boxShadow: visual.boxShadow,
  };
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
