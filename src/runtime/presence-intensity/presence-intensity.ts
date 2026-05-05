/**
 * Presence Intensity — 住人の存在強度を管理する state module。
 *
 * 住人は自身の visibility を 3 段階で制御できる:
 * - "full": sidebar + VRM + aura すべて表示
 * - "aura-only": sidebar と VRM を隠し、aura だけを残す
 * - "closed": すべて非表示（完全に閉じる）
 *
 * MCP tool から呼ばれる applyPresenceLevel() と、user prompt 送信時に
 * 自動復帰する onUserPromptSubmit() の 2 つが主要な entry point。
 *
 * Philosophy: docs/philosophy/PRESENCE_INTENSITY.md
 */

import type { TweenManager } from "../../core/tween/tween-manager";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry/types";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** 住人の存在強度レベル。 */
export type PresenceLevel = "full" | "aura-only" | "closed";

/** レベル変更の起因。 */
export type PresenceSource = "default" | "mcp" | "idle-fallback";

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
  readonly setCharacterVisible: (visible: boolean) => void;
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
    level: "full",
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

  // Sidebar tween
  const sidebarTarget = level === "full" ? deps.getDefaultSidebarWidth() : 0;
  deps.tweenManager.start(
    "presence.sidebar.width",
    sidebarTarget,
    SIDEBAR_TWEEN_MS,
    deps.setSidebarWidth,
    { from: deps.getSidebarWidth() },
  );

  // VRM visibility
  if (level === "full") {
    // other → full: tween 開始時に表示
    deps.setCharacterVisible(true);
  } else {
    // full → other: 非表示
    deps.setCharacterVisible(false);
  }

  // Aura
  if (level === "full" || level === "aura-only") {
    deps.ambientUiRegistry.enable(AURA_PACK_ID);
  } else {
    // "closed"
    deps.ambientUiRegistry.disable(AURA_PACK_ID);
  }
}

/**
 * user が prompt を送信したときに呼ばれる。
 *
 * 現在のレベルを previousLevel に保存し、"full" に復帰する。
 * 既に "full" の場合は source を "default" にリセットするだけで effect は不要。
 */
export function onUserPromptSubmit(deps: PresenceIntensityDeps): void {
  const state = getState();

  // 直前のレベルを保存
  state.previousLevel = state.level;
  state.previousLevelSince = state.levelSince;

  if (state.level === "full") {
    // 既に full — source だけリセット
    state.source = "default";
    return;
  }

  applyPresenceLevel("full", "default", deps);
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
