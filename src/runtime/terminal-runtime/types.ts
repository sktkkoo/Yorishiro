import type { ITheme as XTermTheme } from "@xterm/xterm";
import type { Disposable, TerminalCellData } from "@yorishiro/sdk";
import type { SpawnSpec } from "../../bindings/tauri-commands";
import type { Perception } from "../../core/perception";
import type { TerminalCommandRun } from "./command-run-store";
import type { RegionPoint } from "./region-selection";
import type { TerminalProblem } from "./terminal-problems";

/**
 * PTY 接続パラメータ。差分検出に使う。null 値は「まだ決まっていない」を表す。
 * cwd は App.tsx の state から渡される。cols / rows は xterm が決める
 * （FitAddon が container サイズから算出）。
 *
 * spec は profile resolution 後の SpawnSpec。Agent variant のときは
 * systemPrompt も spec.systemPrompt に乗る。
 */
export interface PtyParams {
  readonly spec: SpawnSpec;
  readonly cwd: string | null;
}

export interface UpdatePtyOptions {
  /**
   * true のとき既存 Rust PTY への attach を先に試す。
   * WebView reload 後に session_list で復元済みと分かった session にだけ使う。
   */
  readonly attachFirst?: boolean;
}

export interface TerminalCursorClientPosition {
  readonly clientX: number;
  readonly clientY: number;
  /** xterm 1 セルの幅（px）。attention rect の width 算出に使う。 */
  readonly cellWidth: number;
  /** xterm 1 セルの高さ（px）。attention rect の height 算出に使う。 */
  readonly cellHeight: number;
}

/**
 * viewport の 1 line の rect + text。意味分類は呼び出し側が
 * `classifyTerminalOutputAttentionReason` 等で行う。
 */
export interface TerminalLineRect {
  readonly text: string;
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

/**
 * 参照マーカー付きの terminal text reference。
 * Command+click や Option+Shift+drag で capture → `[#Term<N>]` として入力欄に挿入される。
 * `id` は MCP 向けの session-stamped opaque id（例: `session-1:Term1`）。
 */
export interface TerminalReference {
  readonly id: string;
  readonly context: TerminalRegionContext;
}

/** Terminal が受動的に拾った OSC 9/99/777 notification。 */
export interface TerminalNotificationEvent {
  readonly sessionId: string;
  readonly title: string | null;
  readonly body: string;
  readonly receivedAt: number;
}

export type InterruptProtectionMode = "none" | "repeated" | "all";

export interface LoopReelRecorderSink {
  startSession(
    sessionId: string,
    metadata?: {
      readonly label?: string;
      readonly kind?: "shell" | "agent" | "unknown";
      readonly geometry?: { readonly cols: number; readonly rows: number };
    },
  ): void;
  endSession(sessionId: string): void;
  recordPty(sessionId: string, text: string): void;
  recordResize(sessionId: string, cols: number, rows: number): void;
}

export interface TerminalRegionContext {
  readonly kind: "terminal-region-context";
  readonly sessionId: string;
  readonly text: string;
  readonly capturedAt: number;
  readonly gesture: "option-shift-drag" | "meta-click" | "command-run-reference";
  /** command-run reference だけが持つ。MCP はこの id だけを metadata として見る。 */
  readonly commandRunId?: number;
  readonly viewport: {
    readonly viewportY: number;
    readonly rows: number;
    readonly cols: number;
  };
  readonly range: {
    readonly startRow: number;
    readonly endRow: number;
    readonly startCol: number;
    readonly endCol: number;
  };
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly polygon: ReadonlyArray<RegionPoint>;
}

export interface TerminalCommandRunLocus {
  readonly kind: "terminal-command-run-locus";
  readonly sessionId: string;
  readonly commandRunId: number;
  readonly viewport: {
    readonly viewportY: number;
    readonly rows: number;
    readonly cols: number;
  };
  readonly range: {
    readonly startRow: number;
    readonly endRow: number;
    readonly startCol: number;
    readonly endCol: number;
  };
  readonly rect: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly polygon: ReadonlyArray<RegionPoint>;
}

/**
 * TerminalRuntime の public interface。terminal.tsx が参照するのはこの型だけ。
 *
 * 寿命: webview lifetime（= hot-data 経由で HMR 越しに同一 instance）。
 * 責務:
 *   - xterm / FitAddon の保持
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
   * layout 由来の表示/非表示を切り替える。attach/detach（session active 状態）
   * とは独立。hidden 中は per-frame の rect 同期でも visibility を上書きしない。
   */
  setHidden(hidden: boolean): void;

  /**
   * layout 由来の terminal 全体不透明度（0-1）を設定する。1=完全不透明（既定）。
   * attach/detach をまたいで維持され、per-frame の rect 同期では上書きされない。
   */
  setOpacity(opacity: number): void;

  /** 現在の layout 由来 opacity（single-writer 読み取り用）。未設定時は 1。 */
  getOpacity(): number;

  /**
   * layout 由来：terminal の背景のみ透明化する（文字は不透明のまま）。
   * scene の theme 変更をまたいでもフラグから再適用され、戻らない。
   */
  setBackgroundTransparent(transparent: boolean): void;

  /**
   * attention light cue と同期する terminal 側の発光強度（0-1）。
   * scene light と同じ cue envelope から呼ばれ、文字描画や PTY には触れない。
   */
  setAttentionCueIntensity(intensity: number): void;

  /** Loop Reel 録画 sink を late-bind する。null で録画を無効化する。 */
  setLoopReelRecorder(sink: LoopReelRecorderSink | null): void;

  /** active session の手動録画を開始する。loop_announce が無い時の dogfooding 用。 */
  startRecording(label?: string): void;

  /** active session の手動録画を終了する。 */
  stopRecording(): void;

  /**
   * active recording に現在の xterm geometry を補給する。
   * loop_announce 起点の録画は terminal 側の geometry を知らずに作られるため、
   * 録画開始直後にこれを呼んで初期 resize entry を seed する（store 側 dedup で冪等）。
   * 初期 geometry が無い録画は TUI 再生が崩れる。
   */
  seedLoopReelGeometry(): void;

  /**
   * Session が close されるときに呼ぶ。xterm を dispose、xterm container DOM を
   * document から外し、ResizeObserver / RAF を停止する。dispose 後の
   * runtime instance は再利用しない（再 attach / 再 spawn 不可）。
   */
  dispose(): void;

  /**
   * PTY 接続パラメータを更新する。既存と差分があれば `pty_spawn` を 1 回呼ぶ。
   * 同 params なら no-op（StrictMode double-mount / HMR 再実行で連続呼び出し
   * されても安全）。
   */
  updatePtyParams(params: PtyParams, options?: UpdatePtyOptions): void;

  /**
   * perception prop を singleton に反映する。onmessage / term.onData で MutableRef
   * 経由で参照される。null を渡すことは通常ないが、許容（warn log を出す）。
   */
  setPerception(perception: Perception | null): void;

  /**
   * User が最近キー入力している間だけ、xterm の入力カーソル中心を
   * viewport client 座標で返す。入力中でない / terminal が hidden なら null。
   *
   * 返り値は runtime 所有の再利用バッファで、次回呼び出しで in-place
   * 上書きされる。呼び出しをまたいで保持するなら複製すること。
   */
  getInputCursorClientPosition(): TerminalCursorClientPosition | null;

  /**
   * xterm.js の visible 行からセルデータを抽出する（observation only）。
   * TextPhysics 等の effect が overlay 上に文字を複製するために使う。
   * xterm が未 open なら null を返す。
   */
  extractVisibleCells(): TerminalCellData | null;

  /**
   * PTY からの出力 (data event) ごとに listener を呼ぶ。listener には
   * 何も引数を渡さない (dirty flag 用途)。実際の data 内容は xterm buffer 経由で
   * 取得する。dispose で listener を外す。
   */
  subscribePtyData(listener: () => void): Disposable;

  /**
   * OSC 9 / 99 / 777 notification を受動的に拾ったときに listener を呼ぶ。
   * agent の permission / turn complete などの注意要求を表す。PTY write なし。
   */
  subscribeNotification(listener: (event: TerminalNotificationEvent) => void): Disposable;

  /**
   * User key input が PTY へ送られる直前に listener を呼ぶ。
   * 許可待ち attention の明示解除など、UI read model 更新に使う。
   */
  subscribeUserInput(listener: (data: string) => void): Disposable;

  /**
   * ターミナルのカラーテーマを更新する。scene 切替時に呼ばれる。
   * partial merge で、指定された field だけ上書きする。
   */
  setTheme(theme: Partial<XTermTheme>): void;

  /**
   * 現在 attach されている React placeholder の rect を読み直し、xterm を fit する。
   * scene / UI layout 切替直後など ResizeObserver だけでは反映が遅れる経路で使う。
   */
  refit(): void;

  /**
   * xterm container の viewport scroll が発生したときに listener を呼ぶ。
   * 引数なし (rect 再計算の trigger 用途)。dispose で listener を外す。
   */
  subscribeViewportScroll(listener: () => void): Disposable;

  /**
   * viewport の全 line の rect + text を返す（最終行から逆順）。空白だけの
   * 行は除外。viewport scroll や PTY 出力後に producer が呼ぶ。
   *
   * 意味分類はここではしない（producer 側の責務）。
   *
   * 返り値の array と各 entry / rect は runtime 所有の再利用バッファで、
   * 次回呼び出しで in-place 上書きされる。呼び出しをまたいで保持するなら
   * 複製すること。
   */
  getViewportLineRects(): ReadonlyArray<TerminalLineRect>;

  /**
   * xterm の screen buffer 末尾を text として読む（最終行付近だけ）。
   *
   * getViewportLineRects() と違い DOM rect に依存しないため、非 active tab で
   * xterm container が hidden / detached の間も使える。agent の許可待ち prompt
   * は hook より先に画面へ出るので、低遅延の observation fast-path に使う。
   */
  readScreenTailText(maxLines?: number): string;

  /**
   * Option+Shift+drag / Command+click で capture した最新 terminal context を返す。
   * 未選択 / 空選択なら null。
   */
  getLatestRegionContext(): TerminalRegionContext | null;

  /**
   * Option+Shift+drag / Command+click の terminal context 確定時に listener を呼ぶ。
   * attention producer / UI feedback 用。dispose で listener を外す。
   */
  subscribeRegionContext(listener: (context: TerminalRegionContext) => void): Disposable;

  /**
   * `[#Term<N>]` マーカー付きで蓄積された terminal text reference の一覧。
   * Command+click や Option+Shift+drag で capture → 入力に marker 挿入される。
   */
  getTerminalReferences(): ReadonlyArray<TerminalReference>;

  /** 直近の command run metadata。output text は含まない。 */
  getCommandRunsRecent(limit?: number): ReadonlyArray<TerminalCommandRun>;

  /**
   * 直近 failed run の出力範囲を terminal reference 化する（Attach last failed run）。
   * failed run が無ければ false。PTY へは書かず、既存 click-gate と同じ reference 経路に乗せる。
   */
  attachLastFailedRun(): boolean;

  /** command run の現在 viewport 上の locus。output text は含まない。 */
  getCommandRunLocus(runId: number): TerminalCommandRunLocus | null;

  /**
   * 指定 run で検出された Terminal Problems（file:line / URL / port / test-fail）。
   * 出力全文ではなく検出した断片の metadata のみ。無ければ空配列。
   */
  getCommandRunProblems(runId: number): ReadonlyArray<TerminalProblem>;

  /**
   * 長い scrollback の中を command block 単位で jump する（block navigation）。
   * 現在の viewport 上端より下/上にある最も近い run の start 行へ scroll する。
   * `failedOnly` のときは `status === "failed"` の run だけを対象にする。
   * 対象 run が無ければ false（端での no-op）。scroll は読み取り操作で PTY へは書かない。
   */
  scrollToAdjacentCommandRun(
    direction: "next" | "previous",
    opts?: { readonly failedOnly?: boolean },
  ): boolean;

  /** live command run start を購読する。replay 復元中の run は通知しない。 */
  subscribeCommandRunStarted(listener: (run: TerminalCommandRun) => void): Disposable;

  /** live command run finalize を購読する。replay 復元中の run は通知しない。 */
  subscribeCommandRunFinalized(listener: (run: TerminalCommandRun) => void): Disposable;

  /** 蓄積された terminal reference をすべて消去する。 */
  clearTerminalReferences(): void;

  /** xterm に直接テキストを書き込む（shell ヒントなど）。 */
  writePlainText(text: string): void;

  /** xterm にキーボードフォーカスを移す。タブ切り替え時に使う。 */
  focus(): void;

  /**
   * body 直下の xterm singleton が直接操作されたときに呼ばれる。
   * React placeholder の pointer event では拾えないため runtime 側で橋渡しする。
   */
  subscribeActivation(listener: () => void): Disposable;

  /**
   * Ctrl+C を PTY に送るか制御する。
   * main agent の accidental exit 防止用で、shell session には使わない。
   */
  setInterruptProtectionMode(mode: InterruptProtectionMode): void;

  /** currentParams を無効化し updatePtyParams を再実行する。auto-respawn 用。 */
  forceRespawn(): void;
}
