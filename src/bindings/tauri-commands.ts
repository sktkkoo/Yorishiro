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

// Tauri's invoke typing requires `Record<string, unknown>` compatible args.
// Our typed arg interfaces (readonly, closed-shape) aren't index-signature
// compatible, so we launder them through InvokeArgs once inside each wrapper.
// Callers never see the cast.
const call = <T>(cmd: string, args: object): Promise<T> =>
  invoke<T>(cmd, args as unknown as InvokeArgs);

// ─── PTY ────────────────────────────────────────────────────────

export interface PtySpawnArgs {
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string | null;
  readonly systemPrompt: string | null;
  readonly onOutput: Channel<ArrayBuffer>;
}

/** Spawn the claude PTY. Kills any existing session first. */
export const ptySpawn = (args: PtySpawnArgs): Promise<void> => call("pty_spawn", args);

export interface PtyWriteArgs {
  readonly data: string;
}

/** Forward user input bytes to the PTY's stdin. */
export const ptyWrite = (args: PtyWriteArgs): Promise<void> => call("pty_write", args);

export interface PtyResizeArgs {
  readonly cols: number;
  readonly rows: number;
}

/** Propagate xterm size changes to the PTY master. */
export const ptyResize = (args: PtyResizeArgs): Promise<void> => call("pty_resize", args);
