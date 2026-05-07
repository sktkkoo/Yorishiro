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
      /** Claude Code に渡す localized plugin dir。未指定なら Rust 側 fallback。 */
      readonly pluginDir?: string | null;
    }
  | {
      readonly kind: "shell";
      /** shell binary 上書き。null で `$SHELL` を使う。 */
      readonly command?: string | null;
      /**
       * Charminal 側 instrumentation（OSC 133 wrapper rc）の有無。default true。
       * false なら raw shell 起動で、住人は cell 観察のみ（command 単位の status
       * は読めない）。known でない shell（sh / dash 等）には integration が無視される。
       */
      readonly integration?: boolean;
    };

/**
 * Tauri 側 SessionDescriptor と 1:1 mirror。session_list の戻り値などで使う。
 */
export interface SessionDescriptor {
  readonly id: string;
  readonly profileId: string;
  readonly kind: "shell" | "agent";
  readonly label: string;
  readonly cwd: string | null;
  readonly startedAt: number;
}

export interface SessionSpawnArgs {
  /** 任意の session id。null/undefined なら default-session を作る。 */
  readonly sessionId?: string | null;
  readonly spec: SpawnSpec;
  readonly cols: number;
  readonly rows: number;
  readonly cwd: string | null;
  readonly onOutput: Channel<ArrayBuffer>;
}

/**
 * Session を新規 spawn する。session_id が省略されると default-session を
 * 作る（Phase B-1 互換）。pane split で複数 session を持つときは caller が
 * paneId 由来の session_id を渡す。
 */
export const sessionSpawn = (args: SessionSpawnArgs): Promise<void> => call("session_spawn", args);

export interface SessionWriteArgs {
  readonly sessionId: string;
  readonly data: string;
}

/** Per-session の stdin 書き込み。 */
export const sessionWrite = (args: SessionWriteArgs): Promise<void> => call("session_write", args);

export interface SessionResizeArgs {
  readonly sessionId: string;
  readonly cols: number;
  readonly rows: number;
}

/** Per-session の cols/rows 反映。 */
export const sessionResize = (args: SessionResizeArgs): Promise<void> =>
  call("session_resize", args);

export interface SessionDestroyArgs {
  readonly sessionId: string;
}

/** Session を kill して registry から外す。 */
export const sessionDestroy = (args: SessionDestroyArgs): Promise<void> =>
  call("session_destroy", args);

export interface SessionAttachArgs {
  readonly sessionId: string;
  readonly cwd: string | null;
  readonly onOutput: Channel<ArrayBuffer>;
}

/**
 * 既存 session に新しい channel を繋ぎ直す（webview HMR reload など）。
 * Returns true if re-attached、false なら caller が spawn 必要。
 */
export const sessionAttach = (args: SessionAttachArgs): Promise<boolean> =>
  call("session_attach", args);

export interface SessionDetachArgs {
  readonly sessionId: string;
}

/** Channel を外すだけで PTY は kill しない。 */
export const sessionDetach = (args: SessionDetachArgs): Promise<void> =>
  call("session_detach", args);

/** Registry に登録されてる全 session の descriptor を返す。 */
export const sessionList = (): Promise<ReadonlyArray<SessionDescriptor>> => invoke("session_list");

export interface PrepareLocalizedPluginDirArgs {
  readonly language: "en" | "ja";
}

/** resolved language に対応する Claude Code plugin dir を生成して返す。 */
export const prepareLocalizedPluginDir = (args: PrepareLocalizedPluginDirArgs): Promise<string> =>
  call("prepare_localized_plugin_dir", args);

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
