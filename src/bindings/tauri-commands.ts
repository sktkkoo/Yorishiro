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
import type { SnapshotEntry } from "../sdk/history";

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
      /** Adapter id（`listSupportedAgents()` が返す id のいずれか）。 */
      readonly agent: string;
      /** binary 上書き。null で既定の agent binary 検索を使う。 */
      readonly command?: string | null;
      readonly systemPrompt?: string | null;
      /** Claude Code plugin dir / Codex local marketplace root。未指定なら Rust 側 fallback。 */
      readonly pluginDir?: string | null;
    }
  | {
      readonly kind: "shell";
      /** shell binary 上書き。null で `$SHELL` を使う。 */
      readonly command?: string | null;
      /**
       * Charminal 側 instrumentation（OSC 133 / 633 wrapper rc）の有無。default true。
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
  readonly displayCwd: string | null;
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
 * 作る（Phase B-1 互換）。複数 session を持つときは caller が stable な
 * session_id を渡す。
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

export interface SessionRefreshThemeArgs {
  readonly sessionId: string;
}

/** Agent session に terminal theme refresh を通知する。非対応 agent では no-op。 */
export const sessionRefreshTheme = (args: SessionRefreshThemeArgs): Promise<void> =>
  call("session_refresh_theme", args);

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

export interface SessionAttachResult {
  readonly attached: boolean;
  readonly replay: ReadonlyArray<number>;
}

/**
 * 既存 session に新しい channel を繋ぎ直す（webview HMR reload など）。
 * live output は raw Channel のまま、replay bytes だけ invoke response で返す。
 */
export const sessionAttach = (args: SessionAttachArgs): Promise<SessionAttachResult> =>
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

/** resolved language に対応する agent plugin runtime dir を生成して返す。 */
export const prepareLocalizedPluginDir = (args: PrepareLocalizedPluginDirArgs): Promise<string> =>
  call("prepare_localized_plugin_dir", args);

export interface ResolveCommandPathArgs {
  readonly command: string;
}

/** Charminal の launch PATH 上で command が解決できるかを返す。 */
export const resolveCommandPath = (args: ResolveCommandPathArgs): Promise<string | null> =>
  call("resolve_command_path", args);

export interface ResolveProjectRootArgs {
  readonly cwd: string;
}

/** cwd を canonicalize し、git root / linked worktree の本体 root に解決する。 */
export const resolveProjectRoot = (args: ResolveProjectRootArgs): Promise<string> =>
  call("resolve_project_root", args);

export interface AgentCapabilities {
  readonly personaOverlay: boolean;
  readonly mcpInjection: boolean;
  readonly plugins: boolean;
  readonly lifecycleHooks: boolean;
  readonly sessionResume: boolean;
}

/** yori コマンドの記法（`<prefix>yori<separator><name>`）。Rust adapter が正本。 */
export interface CommandSyntax {
  readonly prefix: string;
  readonly separator: string;
}

export interface AgentDescriptor {
  readonly id: string;
  readonly displayName: string;
  readonly binaryName: string;
  readonly capabilities: AgentCapabilities;
  readonly commandSyntax: CommandSyntax;
}

/** 登録済み terminal agent adapter の一覧を返す。 */
export const listSupportedAgents = (): Promise<readonly AgentDescriptor[]> =>
  call("list_supported_agents", {});

export interface McpServerStatus {
  readonly port: number | null;
  readonly error: string | null;
}

/** MCP server の startup 結果を返す。 */
export const mcpServerStatus = (): Promise<McpServerStatus> => invoke("mcp_server_status");

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

// ─── History (pack rollback) ────────────────────────────────────

export type { SnapshotEntry };

/** `history::snapshot_list()` → 新しい順の SnapshotEntry[]。 */
export const snapshotList = (): Promise<ReadonlyArray<SnapshotEntry>> => invoke("snapshot_list");

/** `history::snapshot_create(trigger, label)` → 採番された seq。 */
export const snapshotCreate = (args: { trigger: string; label?: string }): Promise<number> =>
  call("snapshot_create", args);

/** `history::snapshot_restore(seq, paths?)` → full-replace 復元（破壊的）。 */
export const snapshotRestore = (args: {
  seq: number;
  paths?: ReadonlyArray<string>;
}): Promise<void> => call("snapshot_restore", args);

/** `history::snapshot_prune(keep_n)` → 直近 keepN 件に間引く。 */
export const snapshotPrune = (args: { keepN: number }): Promise<void> =>
  call("snapshot_prune", args);

// ─── System exec (amenity) ─────────────────────────────────────

export interface SystemExecArgs {
  readonly packId: string;
  readonly command: string;
  readonly options?: {
    readonly cwd?: string;
    readonly env?: Record<string, string>;
    readonly timeoutMs?: number;
    readonly input?: string;
    readonly quiet?: boolean;
  };
}

export interface SystemExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

/** amenity pack の system.exec が使う shell command 実行。 */
export const systemExec = (args: SystemExecArgs): Promise<SystemExecResult> =>
  call("system_exec", args);
