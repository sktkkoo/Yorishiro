/**
 * Mouse attention producer。
 *
 * v1 (three-runtime.ts) の挙動を v2 producer 構造に移植。
 *
 * - **pointerdown**: 1〜3 秒のランダム active window を開く。window 中は
 *   priority 9 / confidence 0.9 で "cursor-attention:mouse-click" を emit。
 *   target 要素が interactive (`<button>` / `<a>` / `[role="button"]` / `<input>`
 *   / `<select>` / `<textarea>` / `<label>`) かつ bounding rect が有効な場合は
 *   要素 rect を使用し、それ以外はポインタ座標 ± 10px の 20×20 halo。
 * - **pointermove** (active window 中のみ): rect をポインタ位置に追従させる。
 *   active window 外の move は無視。
 * - **active window 満了**: `setSourceTarget("mouse", null)` で source を解放。
 * - **dispose**: listener を外し、active timer を cancel し、source を null clear。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 * 「Producer の集約場所 (B 案)」section
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

/** v1 に合わせた priority */
const PRIORITY = 9;
/** v1 に合わせた confidence */
const CONFIDENCE = 0.9;
/** halo 半径 (px) — 20×20 halo の半分 */
const HALO_RADIUS_PX = 10;
/** active window の最小秒数 */
const ACTIVE_DURATION_MIN_S = 1;
/** active window の最大秒数 */
const ACTIVE_DURATION_MAX_S = 3;

const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL"]);

interface StartOptions {
  readonly attention: AttentionRuntime;
  /**
   * テスト時に差し込める乱数ソース (0〜1 の一様乱数)。
   * 省略時は `Math.random` を使用する。
   */
  readonly random?: () => number;
  /**
   * テスト時に差し込めるタイマー (`setTimeout` / `clearTimeout` の pair)。
   * ID は number として扱う (jsdom / Node の型差異を吸収)。
   * 省略時は `window.setTimeout` / `window.clearTimeout` を使用する。
   */
  readonly timer?: {
    set: (fn: () => void, ms: number) => number;
    clear: (id: number) => void;
  };
  /**
   * テスト時に差し込める時刻ソース (`performance.now` 相当)。
   * 省略時は `performance.now` を使用する。
   */
  readonly now?: () => number;
}

export function startMouseAttentionProducer(opts: StartOptions): Disposable {
  const { attention } = opts;
  const random = opts.random ?? Math.random;
  const timerSet =
    opts.timer?.set ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms) as number);
  const timerClear = opts.timer?.clear ?? ((id: number) => window.clearTimeout(id));
  const getNow = opts.now ?? (() => performance.now());

  /** active window の終了時刻 (ms)。0 = inactive */
  let activeUntil = 0;
  /** active window を閉じる setTimeout の ID */
  let activeTimer: number | null = null;

  /** active window を終了して source を null clear する */
  const expireActiveWindow = (): void => {
    activeUntil = 0;
    activeTimer = null;
    attention.setSourceTarget("mouse", null);
  };

  /**
   * ポインタ座標と event target から attention rect を決定する。
   * interactive 要素で bounding rect が有効な場合は要素 rect を、
   * それ以外はポインタ座標の 20×20 halo を返す。
   */
  const computeRect = (
    clientX: number,
    clientY: number,
    target: EventTarget | null,
  ): { x: number; y: number; width: number; height: number } => {
    if (target instanceof Element) {
      if (INTERACTIVE_TAGS.has(target.tagName) || target.getAttribute("role") === "button") {
        const r = target.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) {
          return { x: r.left, y: r.top, width: r.width, height: r.height };
        }
      }
    }
    return {
      x: clientX - HALO_RADIUS_PX,
      y: clientY - HALO_RADIUS_PX,
      width: HALO_RADIUS_PX * 2,
      height: HALO_RADIUS_PX * 2,
    };
  };

  /** attention を emit する */
  const emitTarget = (clientX: number, clientY: number, target: EventTarget | null): void => {
    attention.setSourceTarget("mouse", {
      kind: "mouse",
      source: "mouse",
      rect: computeRect(clientX, clientY, target),
      confidence: CONFIDENCE,
      priority: PRIORITY,
      timestamp: getNow(),
      reason: "cursor-attention:mouse-click",
    });
  };

  const onPointerDown = (event: PointerEvent): void => {
    // 既存の active window をリセット
    if (activeTimer !== null) {
      timerClear(activeTimer);
      activeTimer = null;
    }

    const durationS =
      ACTIVE_DURATION_MIN_S + random() * (ACTIVE_DURATION_MAX_S - ACTIVE_DURATION_MIN_S);
    activeUntil = getNow() + durationS * 1000;

    emitTarget(event.clientX, event.clientY, event.target);

    activeTimer = timerSet(expireActiveWindow, durationS * 1000);
  };

  const onPointerMove = (event: PointerEvent): void => {
    // active window 外の move は無視
    if (getNow() >= activeUntil) return;
    emitTarget(event.clientX, event.clientY, event.target);
  };

  const options = { capture: true, passive: true };
  window.addEventListener("pointerdown", onPointerDown, options);
  window.addEventListener("pointermove", onPointerMove, options);

  return {
    dispose: () => {
      window.removeEventListener("pointerdown", onPointerDown, options);
      window.removeEventListener("pointermove", onPointerMove, options);
      if (activeTimer !== null) {
        timerClear(activeTimer);
        activeTimer = null;
      }
      attention.setSourceTarget("mouse", null);
    },
  };
}
