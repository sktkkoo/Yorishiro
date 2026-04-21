/**
 * Tauri ↔ TS invoke() の型境界。
 *
 * Rust 側 `src-tauri/src/lib.rs` の `#[tauri::command]` 関数と 1:1 で対応する
 * 薄い wrapper を集約する。command 名の typo / payload の型不一致 / 戻り値の
 * 誤解釈を tsc の段階で検出することが目的。
 *
 * 命名規約: Rust の関数名（snake_case）→ TS では camelCase。フィールド名も
 * Tauri 側の default rename で snake_case ↔ camelCase が自動変換されるので、
 * TS 側は常に camelCase で書く。
 *
 * 追加は 1:1。Rust 側の signature を変えたときは本ファイルも同時に更新する。
 * 現状は PTY 3 つのみ。hooks / FS / window は実装と同時に足していく。
 */

import { type Channel, type InvokeArgs, invoke } from "@tauri-apps/api/core";

// Tauri の invoke() は引数に Record<string, unknown> 互換を求める。こちらの
// typed args interface は readonly + closed-shape で index signature を持たず
// そのままでは通らないため、wrapper 内で 1 回だけ InvokeArgs 経由で cast する。
// 呼び出し側にはこの cast を露出しない。
const call = <T>(cmd: string, args: object): Promise<T> =>
  invoke<T>(cmd, args as unknown as InvokeArgs);

// ─── PTY ────────────────────────────────────────────────────────

export interface PtySpawnArgs {
  readonly agent: "claude" | "codex";
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string | null;
  readonly systemPrompt: string | null;
  readonly onOutput: Channel<ArrayBuffer>;
}

/** coding agent の PTY を起動する。既存セッションが残っていれば kill してから spawn する。 */
export const ptySpawn = (args: PtySpawnArgs): Promise<void> => call("pty_spawn", args);

export interface PtyWriteArgs {
  readonly data: string;
}

/** ユーザー入力のバイト列を PTY の stdin に転送する。 */
export const ptyWrite = (args: PtyWriteArgs): Promise<void> => call("pty_write", args);

export interface PtyResizeArgs {
  readonly cols: number;
  readonly rows: number;
}

/** xterm 側の cols/rows 変化を PTY master に伝える。 */
export const ptyResize = (args: PtyResizeArgs): Promise<void> => call("pty_resize", args);
