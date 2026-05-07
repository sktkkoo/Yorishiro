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
}

/** 本モジュールが touch する全 style プロパティ（resetLayout の loop で参照） */
const MANAGED_STYLE_KEYS = [
  "width",
  "minWidth",
  "display",
  "position",
  "zIndex",
  "background",
  "borderRight",
  "top",
  "left",
  "height",
] as const;

export function applyLayout(layout: UiLayout, targets: LayoutTargets): void {
  // sidebar
  if (layout.sidebar) {
    const s = layout.sidebar;
    if (s.width === "fullscreen") {
      targets.sidebar.style.width = "100vw";
      targets.sidebar.style.minWidth = "100vw";
    } else if (s.width === "hidden") {
      targets.sidebar.style.display = "none";
    } else if (typeof s.width === "number") {
      targets.sidebar.style.width = `${s.width}px`;
      targets.sidebar.style.minWidth = `${s.width}px`;
    }
    // "default" は何もしない（元の CSS が効く）

    if (s.position === "overlay") {
      targets.sidebar.style.position = "fixed";
      targets.sidebar.style.zIndex = "100";
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
}

/** applyLayout が touch する全 style プロパティを空文字に戻す。 */
export function resetLayout(targets: LayoutTargets): void {
  for (const target of [targets.root, targets.sidebar, targets.terminal, targets.character]) {
    for (const key of MANAGED_STYLE_KEYS) {
      (target.style as unknown as Record<string, string>)[key] = "";
    }
  }
}
