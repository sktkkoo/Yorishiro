/**
 * UI pack の layout spec を HTMLElement の style に適用する pure function。
 *
 * - applyLayout は「layout spec で指定された項目だけ書く」（指定 field だけ触る）
 * - resetLayout は「このモジュールが touch する全 style プロパティを空文字に戻す」
 * - full-replace semantics を実現するには、呼び出し側が `reset → apply` のセットで使う
 *
 * full-replace が必要なのは UiLayoutAPI.update のような runtime 変更で、
 * 前回 apply した値が残ると予測不能になるため（specs/2026-04-21-ui-pack-design.md）。
 */

import type { UiLayout } from "@charminal/sdk";

export interface LayoutTargets {
  readonly root: HTMLElement;
  readonly terminal: HTMLElement;
  readonly sidebar: HTMLElement;
  readonly character: HTMLElement;
  readonly chrome: HTMLElement;
  /** タブインジケータ（セッション切替の pill）。常時存在するとは限らないため optional。 */
  readonly tabIndicator?: HTMLElement;
}

/** 本モジュールが touch する全 style プロパティ（resetLayout の loop で参照） */
const MANAGED_STYLE_KEYS = [
  "width",
  "minWidth",
  "flexBasis",
  "display",
  "position",
  "zIndex",
  "background",
  "borderRight",
  "top",
  "left",
  "height",
  // applyLayout は書かないが、stage 遷移（ui-pack-transition）が chrome に marginTop
  // （占有スペースを畳む退避）や transform を残しうるため、deactivate 時の reset で clear する。
  "marginTop",
  "transform",
] as const;

export function applyLayout(layout: UiLayout, targets: LayoutTargets): void {
  // sidebar
  if (layout.sidebar) {
    const s = layout.sidebar;
    if (s.width === "fullscreen") {
      targets.sidebar.style.width = "100vw";
      targets.sidebar.style.minWidth = "100vw";
      targets.sidebar.style.flexBasis = "100vw";
      // stage を fullscreen にするとき character 描画域も全画面へ広げる。
      // .charactor-container は通常 --sidebar-content-width(280px) 固定（presence
      // sidebar tween 中の VRM reflow を防ぐため）。fullscreen UI pack では canvas/camera を
      // 全画面に追従させたいので、ここで明示的に上書きする（ThreeRuntime の ResizeObserver が拾う）。
      targets.character.style.width = "100vw";
      targets.character.style.minWidth = "100vw";
    } else if (s.width === "hidden") {
      targets.sidebar.style.display = "none";
    } else if (typeof s.width === "number") {
      targets.sidebar.style.width = `${s.width}px`;
      targets.sidebar.style.minWidth = `${s.width}px`;
      targets.sidebar.style.flexBasis = `${s.width}px`;
    }
    // "default" は何もしない（元の CSS が効く）

    if (s.position === "overlay") {
      // fixed 要素は top/left/height を与えないと縦に潰れる（高さ＝内容依存）。
      // P1 で overlay target は .shell-column になり、chrome 非表示時は
      // 子の character viewport が flex:1 で親高さ 0 を継承 → キャラ不可視に
      // なるため、viewport 全体（top/left/height）を明示して占有させる。
      targets.sidebar.style.position = "fixed";
      targets.sidebar.style.zIndex = "100";
      targets.sidebar.style.top = "0";
      targets.sidebar.style.left = "0";
      targets.sidebar.style.height = "100vh";
    }
    if (s.transparent) {
      targets.sidebar.style.background = "transparent";
      targets.sidebar.style.borderRight = "none";
    }
  }

  // terminal
  if (layout.terminal) {
    const t = layout.terminal;
    if (t.position === "hidden") {
      targets.terminal.style.display = "none";
    } else if (t.position === "bottom") {
      // 画面下 40%、sidebar 右側に配置する shortcut。下半分パネル系の UI pack 用
      targets.terminal.style.position = "fixed";
      targets.terminal.style.top = "60%";
      targets.terminal.style.left = "var(--sidebar-width)";
      targets.terminal.style.width = "calc(100% - var(--sidebar-width))";
      targets.terminal.style.height = "40%";
    } else if (typeof t.position === "object") {
      targets.terminal.style.position = "fixed";
      targets.terminal.style.top = t.position.top;
      targets.terminal.style.left = t.position.left;
      targets.terminal.style.width = t.position.width;
      targets.terminal.style.height = t.position.height;
    }
    // "default" は何もしない
  }

  // character
  if (layout.character) {
    if (layout.character.visible === false) {
      targets.character.style.display = "none";
    }
  }

  // chrome
  if (layout.chrome) {
    if (layout.chrome.visible === false) {
      targets.chrome.style.display = "none";
    }
  }

  // tab-indicator（セッション切替の pill）。terminal が見えない全画面モードでは
  // タブ切替が無意味なので隠せる。target が無い構成（タブ未描画）では no-op。
  if (layout.tabIndicator && targets.tabIndicator) {
    if (layout.tabIndicator.visible === false) {
      targets.tabIndicator.style.display = "none";
    }
  }
}

/** applyLayout が touch する全 style プロパティを空文字に戻す。 */
export function resetLayout(targets: LayoutTargets): void {
  for (const target of [
    targets.root,
    targets.sidebar,
    targets.terminal,
    targets.character,
    targets.chrome,
    targets.tabIndicator,
  ]) {
    if (!target) continue;
    for (const key of MANAGED_STYLE_KEYS) {
      (target.style as unknown as Record<string, string>)[key] = "";
    }
  }
}
