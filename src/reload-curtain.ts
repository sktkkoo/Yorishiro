// reload curtain — project 切替 reload の瞬断を暗転フェードで隠す。
//
// 白フラッシュ抑止は index.html / tauri.conf.json の暗色背景（static）が担っていて、
// この curtain は純粋に遷移演出。reload 前に fade-in し、sessionStorage の
// フラグで reload をまたぎ、user layer ready 後に fade-out する。
// curtain は入力を塞ぐ（pointer-events: auto）ため、ready にならない場合の
// failsafe で必ず開ける。

import { useCallback, useEffect, useRef, useState } from "react";

export const RELOAD_CURTAIN_STORAGE_KEY = "yorishiro:reload-curtain";
export const RELOAD_CURTAIN_FADE_MS = 360;
export const RELOAD_CURTAIN_MIN_VISIBLE_MS = 520;
export const RELOAD_CURTAIN_FAILSAFE_MS = 5000;
// visible class が実際に描画された後、fade-in の transition 完了から reload 発火までの猶予。
const PRE_RELOAD_HOLD_MS = 80;

export type ReloadCurtainPhase = "hidden" | "entering" | "visible" | "leaving";

function hasPendingCurtain(): boolean {
  try {
    return sessionStorage.getItem(RELOAD_CURTAIN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function markCurtainPending(): void {
  try {
    sessionStorage.setItem(RELOAD_CURTAIN_STORAGE_KEY, "1");
  } catch {
    // sessionStorage が使えない環境でも reload 自体は進める
  }
}

function clearCurtainPending(): void {
  try {
    sessionStorage.removeItem(RELOAD_CURTAIN_STORAGE_KEY);
  } catch {
    // 演出は best-effort
  }
}

function defaultReload(): void {
  window.location.reload();
}

function afterNextPaint(callback: () => void): void {
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(callback);
  });
}

export function useReloadCurtain(
  isReady: boolean,
  reload: () => void = defaultReload,
): { phase: ReloadCurtainPhase; beginCurtainReload: () => void } {
  const fromReloadRef = useRef(hasPendingCurtain());
  const visibleAtRef = useRef<number | null>(fromReloadRef.current ? performance.now() : null);
  const reloadInFlightRef = useRef(false);
  const [phase, setPhase] = useState<ReloadCurtainPhase>(
    fromReloadRef.current ? "visible" : "hidden",
  );

  const beginCurtainReload = useCallback(() => {
    if (reloadInFlightRef.current) return;
    reloadInFlightRef.current = true;
    markCurtainPending();
    setPhase("entering");
    // entering(opacity: 0) を一度 paint させてから visible にしないと、
    // WebView が class 変更をまとめて fade-in を飛ばすことがある。
    afterNextPaint(() => {
      setPhase("visible");
      window.setTimeout(() => {
        reload();
      }, RELOAD_CURTAIN_FADE_MS + PRE_RELOAD_HOLD_MS);
    });
  }, [reload]);

  // fade-out: reload 後、user layer ready を待って開ける。
  // 最低表示時間を満たしてから leaving に入れる（一瞬で開くとちらつく）。
  useEffect(() => {
    if (!fromReloadRef.current || !isReady) return;
    const visibleForMs =
      visibleAtRef.current === null ? 0 : performance.now() - visibleAtRef.current;
    const holdMs = Math.max(0, RELOAD_CURTAIN_MIN_VISIBLE_MS - visibleForMs);
    const leave = window.setTimeout(() => {
      fromReloadRef.current = false;
      clearCurtainPending();
      setPhase("leaving");
    }, holdMs);
    const hide = window.setTimeout(() => {
      setPhase("hidden");
    }, holdMs + RELOAD_CURTAIN_FADE_MS);
    return () => {
      window.clearTimeout(leave);
      window.clearTimeout(hide);
    };
  }, [isReady]);

  // failsafe: ready にならなくても一定時間で必ず開ける
  useEffect(() => {
    if (!fromReloadRef.current || isReady) return;
    let hide: number | null = null;
    const failsafe = window.setTimeout(() => {
      fromReloadRef.current = false;
      clearCurtainPending();
      setPhase("leaving");
      hide = window.setTimeout(() => {
        setPhase("hidden");
      }, RELOAD_CURTAIN_FADE_MS);
    }, RELOAD_CURTAIN_FAILSAFE_MS);
    return () => {
      window.clearTimeout(failsafe);
      if (hide !== null) window.clearTimeout(hide);
    };
  }, [isReady]);

  return { phase, beginCurtainReload };
}
