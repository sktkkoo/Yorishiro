import type { TerminalCellData } from "@charminal/sdk";
import type { Perception } from "../../core/perception";

/**
 * PTY 接続パラメータ。差分検出に使う。null 値は「まだ決まっていない」を表す。
 * cwd / systemPrompt は App.tsx の state から渡される。cols / rows は xterm が
 * 決める（FitAddon が container サイズから算出）。
 */
export interface PtyParams {
  readonly cwd: string | null;
  readonly systemPrompt: string | null;
}

/**
 * TerminalRuntime の public interface。terminal.tsx が参照するのはこの型だけ。
 *
 * 寿命: webview lifetime（= hot-data 経由で HMR 越しに同一 instance）。
 * 責務:
 *   - xterm / FitAddon / WebglAddon の保持
 *   - Tauri Channel<ArrayBuffer> の永続保持（React lifecycle と無関係）
 *   - PTY 接続パラメータの差分管理（同じ params なら spawn 呼び出しを抑制）
 *   - perception prop の MutableRef 反映
 *
 * 非責務:
 *   - PTY の中身を解釈すること（observation only、revelation 3.13）
 *   - VRM / Three.js との結合（反射層は別 runtime で担う）
 *
 * Internal design-record: 2026-04-17-terminal-runtime-singleton.md Section 3.
 */
export interface TerminalRuntime {
  /**
   * React container を xterm の描画先として登録する。複数回呼ばれても冪等。
   * 内部で ResizeObserver を張り、xterm container DOM の CSS 位置を container
   * の rect に追従させる。
   */
  attachTo(container: HTMLElement): void;

  /**
   * React が unmount したときに container 参照を外す。xterm DOM element 自体は
   * document.body 直下に残り、次回 attachTo で再利用される。
   */
  detachContainer(): void;

  /**
   * PTY 接続パラメータを更新する。既存と差分があれば `pty_spawn` を 1 回呼ぶ。
   * 同 params なら no-op（StrictMode double-mount / HMR 再実行で連続呼び出し
   * されても安全）。
   */
  updatePtyParams(params: PtyParams): void;

  /**
   * perception prop を singleton に反映する。onmessage / term.onData で MutableRef
   * 経由で参照される。null を渡すことは通常ないが、許容（warn log を出す）。
   */
  setPerception(perception: Perception | null): void;

  /**
   * xterm.js の visible 行からセルデータを抽出する（observation only）。
   * TextPhysics 等の effect が overlay 上に文字を複製するために使う。
   * xterm が未 open なら null を返す。
   */
  extractVisibleCells(): TerminalCellData | null;
}
