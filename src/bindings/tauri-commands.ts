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

// ─── Session ────────────────────────────────────────────────────

/**
 * SpawnSpec — Rust 側 `sessions::SpawnSpec` と 1:1 mirror。Agent / Shell の
 * discriminated union で、TS 側は SessionProfile から build して渡す。
 */
export type SpawnSpec =
  | {
      readonly kind: "agent";
      readonly agent: "claude" | "codex";
      /** binary 上書き。null で既定の agent binary 検索を使う。 */
      readonly command?: string | null;
      readonly systemPrompt?: string | null;
    }
  | {
      readonly kind: "shell";
      /** shell binary 上書き。null で `$SHELL` を使う。 */
      readonly command?: string | null;
    };

export interface SessionSpawnArgs {
  readonly spec: SpawnSpec;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string | null;
  readonly onOutput: Channel<ArrayBuffer>;
}

/**
 * Session を新規 spawn する。default-session を replace する形で動作（Phase
 * B-1）。Phase C で `sessionId` 引数を取って multi-pane に拡張する。
 */
export const sessionSpawn = (args: SessionSpawnArgs): Promise<void> => call("session_spawn", args);

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

// --- Tutorial -------------------------------------------------------

/** `~/.charminal/.tutorial-done` の存在を確認する。 */
export const checkTutorialDone = (): Promise<boolean> => invoke("check_tutorial_done");

/** `~/.charminal/.tutorial-done` を作成する。 */
export const markTutorialDone = (): Promise<void> => invoke("mark_tutorial_done");
