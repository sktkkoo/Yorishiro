/**
 * `initTerminalTheme` — TerminalRuntime のカラーテーマを ScenePackRegistry に bind する
 * lifecycle helper。
 *
 * Boot 時に一度呼び、registry の active scene 変化を購読する。Subscriber は
 * SceneSpec の `terminal` field を `setTheme` に渡す。scene が terminal を
 * 宣言していない場合は DEFAULT_TERMINAL_THEME にフォールバックする。
 */

import type { SceneSpec } from "../../sdk/scene";
import type { Disposable, ScenePackRegistry } from "../scene-pack-registry";
import type { TerminalRuntime } from "../terminal-runtime";
import { DEFAULT_TERMINAL_THEME } from "../terminal-runtime";

export interface InitTerminalThemeResult {
  readonly dispose: () => void;
}

export function initTerminalTheme(
  registry: ScenePackRegistry,
  terminal: TerminalRuntime,
): InitTerminalThemeResult {
  const apply = (scene: SceneSpec | null): void => {
    terminal.setTheme(scene?.terminal ?? DEFAULT_TERMINAL_THEME);
  };

  const sub: Disposable = registry.subscribeActive(apply);
  return { dispose: () => sub.dispose() };
}
