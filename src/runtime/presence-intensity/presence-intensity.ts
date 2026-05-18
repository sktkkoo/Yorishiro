/**
 * Presence Intensity — 住人の存在強度を管理する state module。
 *
 * 住人は自身の visibility を 2 段階で制御できる:
 * - "default": sidebar + VRM + aura すべて表示（通常状態）
 * - "closed": sidebar / VRM / aura すべて非表示
 *
 * MCP tool から呼ばれる applyPresenceLevel() と、user prompt 送信時に
 * 自動復帰する onUserPromptSubmit() の 2 つが主要な entry point。
 *
 * Internal design-record: 2026-05-06-presence-intensity.md
 */

import { easeInOutCubic } from "../../core/tween/lerp";
import type { TweenManager } from "../../core/tween/tween-manager";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry/types";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 住人の存在強度レベル。 */
export type PresenceLevel = "default" | "closed";

/** レベル変更の起因。 */
export type PresenceSource = "default" | "mcp";

/** 存在強度の内部 state。 */
export interface PresenceState {
  level: PresenceLevel;
  /** 現在のレベルに入った timestamp。 */
  levelSince: number;
  /** 直前のレベル（onUserPromptSubmit で保存される）。 */
  previousLevel: PresenceLevel | null;
  /** 直前のレベルに入った timestamp。 */
  previousLevelSince: number | null;
  /** レベル変更の起因。 */
  source: PresenceSource;
}

/** applyPresenceLevel に注入する依存。App.tsx の wiring 時に構築する。 */
export interface PresenceIntensityDeps {
  readonly setSidebarWidth: (px: number) => void;
  readonly getSidebarWidth: () => number;
  readonly getDefaultSidebarWidth: () => number;
  readonly tweenManager: TweenManager;
  readonly ambientUiRegistry: AmbientUiPackRegistry;
  /** ThreeRuntime の render loop pause 制御。closed のとき CPU/GPU を休ませる。 */
  readonly setRenderPaused: (paused: boolean) => void;
  readonly now: () => number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** sidebar 開閉 tween の duration（後で帰納的に調整する）。 */
const SIDEBAR_TWEEN_MS = 1500;

/** attention-aura pack の id。 */
const AURA_PACK_ID = "attention-aura";

// ---------------------------------------------------------------------------
// Singleton state
// ---------------------------------------------------------------------------

function createInitialState(): PresenceState {
  return {
    level: "default",
    levelSince: 0,
    previousLevel: null,
    previousLevelSince: null,
    source: "default",
  };
}

function getState(): PresenceState {
  return getOrInit<PresenceState>(KEYS.PRESENCE_INTENSITY, createInitialState);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * 現在の存在強度 state を返す（読み取り専用の意図、mutation は applyPresenceLevel 経由）。
 */
export function getPresenceState(): PresenceState {
  return getState();
}

/**
 * 存在強度レベルを変更し、対応する side-effect を発火する。
 *
 * 同一レベルへの適用は effect をスキップするが、source は更新する。
 */
export function applyPresenceLevel(
  level: PresenceLevel,
  source: PresenceSource,
  deps: PresenceIntensityDeps,
): void {
  const state = getState();
  const prevLevel = state.level;

  // source は常に更新
  state.source = source;

  if (level === prevLevel) {
    // 同一レベル — effect 不要
    return;
  }

  // state 更新
  state.level = level;
  state.levelSince = deps.now();

  // --- Side effects ---

  // Render loop は default に戻る前に必ず resume しておく。
  // sidebar tween は ThreeRuntime の RAF から駆動されるため、paused のままでは
  // open アニメーションが動かない。
  if (level === "default") {
    deps.setRenderPaused(false);
  }

  // Sidebar tween
  const sidebarTarget = level === "default" ? deps.getDefaultSidebarWidth() : 0;
  const handle = deps.tweenManager.start(
    "presence.sidebar.width",
    sidebarTarget,
    SIDEBAR_TWEEN_MS,
    deps.setSidebarWidth,
    { from: deps.getSidebarWidth(), easing: easeInOutCubic },
  );

  // VRM visibility は shell column の display:none に追従するため、ここでは触らない。
  // .shell-column 自体が px<=0 で display:none になれば、その子孫の VRM canvas も paint されない。

  // closed: tween 完了後に render loop を pause（CPU/GPU を休ませる）。
  // 完了直前に default に戻されている可能性があるので、適用時に level を再確認する。
  if (level === "closed") {
    handle.completion.then(() => {
      if (getState().level !== "default") {
        deps.setRenderPaused(true);
      }
    });
  }

  // Aura
  if (level === "default") {
    deps.ambientUiRegistry.enable(AURA_PACK_ID);
  } else {
    deps.ambientUiRegistry.disable(AURA_PACK_ID);
  }
}

/**
 * user が prompt を送信したときに呼ばれる。
 *
 * 現在のレベルを previousLevel に保存し、"default" に復帰する。
 * 既に "default" の場合は source を "default" にリセットするだけで effect は不要。
 */
export function onUserPromptSubmit(deps: PresenceIntensityDeps): void {
  const state = getState();

  // 直前のレベルを保存
  state.previousLevel = state.level;
  state.previousLevelSince = state.levelSince;

  if (state.level === "default") {
    // 既に default — source だけリセット
    state.source = "default";
    return;
  }

  applyPresenceLevel("default", "default", deps);
}

/**
 * シリアライズ用の plain object snapshot を返す。
 * MCP の state.get レスポンスなどで使う。
 */
export function getPresenceSnapshot(): {
  level: PresenceLevel;
  levelSince: number;
  previousLevel: PresenceLevel | null;
  previousLevelSince: number | null;
  source: PresenceSource;
} {
  const state = getState();
  return {
    level: state.level,
    levelSince: state.levelSince,
    previousLevel: state.previousLevel,
    previousLevelSince: state.previousLevelSince,
    source: state.source,
  };
}

/**
 * @internal テスト用リセット。getOrInit の singleton を初期状態に戻す。
 * テストファイルから直接 import して使う。
 */
export function _resetForTest(): void {
  const state = getState();
  const initial = createInitialState();
  state.level = initial.level;
  state.levelSince = initial.levelSince;
  state.previousLevel = initial.previousLevel;
  state.previousLevelSince = initial.previousLevelSince;
  state.source = initial.source;
}
