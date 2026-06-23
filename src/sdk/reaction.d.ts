/**
 * @charminal/sdk/reaction
 *
 * 反応の語彙と trigger system の型定義。
 *
 * ReactionType は persona と amenity の共通 contract。
 * amenity が custom trigger で event を ReactionType に変換し、
 * persona が reflex.responses でその ReactionType を handle する。
 */

// ─── Standard reaction vocabulary ──────────────────────────

/**
 * 標準的な反応タイプ。persona を問わず共通に使える。
 * これ以外の custom reaction も `ReactionType` として受け入れられる。
 */
export type StandardReactionType =
  | "startled" // 驚き、予期しない event
  | "contemplative" // 思考中、考え込み
  | "pleased" // 肯定的、嬉しい
  | "distressed" // エラー、困った状況
  | "curious" // 興味、何かに気づいた
  | "focused" // 集中、作業中
  | "acknowledging" // 了解、頷き
  | "idle-fidget" // 待機中の小動作
  | "confused" // 混乱、分からない
  | "bored"; // 退屈、何もなくて間が持たない

/**
 * 反応タイプ。標準 vocabulary + 任意の custom 文字列。
 * amenity が独自 reaction を定義する場合は custom 文字列を使う。
 * 例: 'build-completed', 'test-passed', 'deploy-failed'
 */
export type ReactionType = StandardReactionType | (string & {});

// ─── Dispatch events ────────────────────────────────────

/**
 * Charminal runtime の trigger loop を流れる event の総称。
 * custom trigger の match 関数の入力として渡される。
 *
 * 「Dispatch」は runtime が dispatcher 経由で trigger match に流すという
 * 意味。event の発信源は runtime が外部から観測した event、runtime が観測結果から
 * 派生させた event、handler が announce する synthetic event に分かれる：
 *
 * - **ObservedEvent**: PTY 出力、hook signal、user 入力、window、scene 変化、
 *   `/charm` command など、runtime が外部から観測したもの
 * - **DerivedEvent**: idle 検知、tool activity など、runtime が観測結果から
 *   pack 作者向けに生成する便利 event
 * - **`SyntheticEvent`**: runtime ではなく persona / amenity の handler が
 *   自ら `ctx.emitEvent()` で発行する合成 event。handler が「観察したこと」
 *   を announce するために使う。詳細は SyntheticEvent の JSDoc 参照
 *
 * どちらも同じ trigger loop を通るので、custom trigger の観点では
 * 区別なく match() の引数として現れる。
 *
 * NOTE: 以前は `EnvironmentEvent` と呼んでいたが、SyntheticEvent が
 * 環境由来ではないため名前が不正確になった。2026-04-12 に `DispatchEvent`
 * へ rename（revelation 3.19 の implementation contract に記載）。
 */
export type DispatchEvent = ObservedEvent | DerivedEvent | SyntheticEvent;

/**
 * Runtime が外部 source から直接観測した event。
 * まだ「何を意味するか」は persona / amenity の trigger が解釈する。
 */
export type ObservedEvent =
  | PtyOutputEvent
  | CommandBlockEvent
  | HookSignalEvent
  | UserInputEvent
  | WindowEvent
  | SceneChangeEvent
  | CharmCommandEvent
  | LoopLifecycleEvent;

/**
 * Runtime が観測結果から生成する便利 event。
 * 元 event より pack 作者が扱いやすい粒度に寄せているため、厳密な upstream event
 * ではなく Charminal runtime の解釈を含む。
 */
export type DerivedEvent = IdleEvent | ToolActivityEvent;

export type SessionId = string;

export interface PtyOutputEvent {
  readonly kind: "pty-output";
  /** PTY から流れてきた生 text（ANSI escape を含む可能性） */
  readonly text: string;
  readonly timestamp: number;
}

export interface CommandBlockEvent {
  readonly kind: "command-block";
  /** OSC 633;E から得た command。未取得の degraded path では null。 */
  readonly command: string | null;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly sessionId: SessionId;
  readonly timestamp: number;
}

export interface HookSignalEvent {
  readonly kind: "hook-signal";
  readonly signal: HookSignal;
  readonly timestamp: number;
}

export interface HookSignal {
  readonly name: /**
   * Claude Code 公式 hook `PreToolUse` のブリッジ。
   *
   * 発火タイミング: tool 呼び出しの直前。
   * 用途: tool 実行の検出、診断 aura のような tool-activity driven の反応。
   */
    | "pre-tool-use"
    /**
     * Claude Code 公式 hook `PostToolUse` のブリッジ。
     *
     * 発火タイミング: tool が正常に完了した直後。
     * 用途: tool 完了の検出、完了後の状態遷移。
     */
    | "post-tool-use"
    /**
     * Claude Code 公式 hook `PostToolUseFailure` のブリッジ。
     *
     * 発火タイミング: tool が失敗した直後（例外・タイムアウト等）。
     * 用途: エラー反応、失敗診断。
     */
    | "post-tool-failure"
    /**
     * Claude Code 公式 hook `UserPromptSubmit` のブリッジ。
     *
     * 発火タイミング: user の Enter 押下瞬間ではなく、**Claude が前ターンの応答を
     * 完了し、次の prompt の処理を開始する境界**で fire する。前ターンが長いと
     * 数十秒の遅延がある。
     *
     * 用途: ターン境界の状態遷移 (例: Body state を thinking に切り替え)。
     * NOT 用途: user の操作瞬間に反応する UI (例: sent aura) — それには
     * `terminal-runtime.subscribeUserSubmit` (xterm.onData の `\r` 検出) を使う。
     * 詳細は docs/decisions/hook-signals.md を参照。
     */
    | "user-prompt-submit"
    /**
     * Claude Code 公式 hook `Stop` のブリッジ。
     *
     * 発火タイミング: Claude が応答を完了した時（ターン終了）。
     * 用途: ターン終了の検出、idle 状態への遷移。
     */
    | "stop"
    /**
     * Claude Code 公式 hook `Notification` のブリッジ。
     *
     * 発火タイミング: Claude が notification を発行した時。
     * 用途: notification に応じた反応（例：warning 類）。
     */
    | "notification";
  readonly payload?: unknown;
}

export interface UserInputEvent {
  readonly kind: "user-input";
  readonly text: string;
  readonly timestamp: number;
}

export interface IdleEvent {
  readonly kind: "idle";
  /** idle に入ってからの経過時間 (ms) */
  readonly durationMs: number;
  readonly timestamp: number;
}

export interface ToolActivityEvent {
  readonly kind: "tool-activity";
  readonly activity: "reading" | "writing" | "running" | "none";
  readonly timestamp: number;
}

export interface WindowEvent {
  readonly kind: "window";
  readonly change: "resize" | "focus" | "blur";
  readonly timestamp: number;
}

export interface SceneChangeEvent {
  readonly kind: "scene-change";
  readonly fromId: string | null;
  readonly toId: string;
  readonly timestamp: number;
}

export interface CharmCommandEvent {
  readonly kind: "charm-command";
  readonly command: string;
  readonly timestamp: number;
}

// ─── Loop lifecycle ────────────────────────────────────────

/**
 * 自律 agent loop の lifecycle phase。
 *
 * ここでの「loop」とは Claude Code / Codex 等が goal に向けて
 * plan → execute → evaluate → adjust を繰り返す long-horizon の自動実行を指す。
 * turn 単位の hook signal（pre-tool-use 等）より上位の構造で、複数 turn に
 * またがる。Charminal はこの loop を **駆動しない**——agent 自身が MCP
 * `loop_announce`（または pack が `ctx.loop.announce`）で自己申告した phase を
 * 観察するだけ。
 *
 * 詳細: docs/decisions/loop-presence-layer.md
 */
export type LoopPhase =
  | "started" // goal を受けて自動実行に入った
  | "iterating" // iteration を 1 周回した（plan→execute→evaluate の刻み）
  | "blocked-on-approval" // 人間の承認待ちで停止（destructive / scope 外操作など）
  | "progress-milestone" // 中間達成（test 通過 / sub-goal 完了など）
  | "failed" // loop が失敗で終わった（stop condition: error）
  | "completed"; // loop が goal 達成で終わった（stop condition: success）

/**
 * 自律 agent loop の lifecycle event。runtime が外部 source（agent の MCP
 * 自己申告 / pack の announce）から観察した loop の状態遷移。
 *
 * `PtyOutputEvent` と同格の `ObservedEvent`——PTY 出力が一つの観察源である
 * のと同じく、loop の構造化 stream も一つの観察源として同じ trigger loop を
 * 流れる。custom trigger は `event.kind === "loop-lifecycle"` で match できる。
 *
 * ## なぜ first-class event か
 *
 * synthetic event の name 規約で代用せず専用 kind にしているのは、(a) phase が
 * closed enum で type-safe に match でき、(b) MCP `loop_announce` 側で phase を
 * validation でき、(c) PTY / hook と並ぶ「観察源」として discoverable にするため。
 *
 * ## 観察境界
 *
 * これは observation であって命令ではない。Charminal は loop を起動・停止・
 * 制御しない。`blocked-on-approval` を観察しても承認を **代行しない**——人間が
 * 端末で操作する（PTY observation-only、docs/decisions/critical-constraints.md §1）。
 *
 * 詳細: docs/decisions/loop-presence-layer.md
 */
export interface LoopLifecycleEvent {
  readonly kind: "loop-lifecycle";
  readonly phase: LoopPhase;
  /**
   * どの agent が報告したか。`"claude"` / `"codex"` 等の terminalAgent id。
   * pack（`ctx.loop`）由来の announce では `null`。
   *
   * **host が stamp する**——caller（agent / pack）は指定できない。観察主体の
   * 帰属を詐称させないため（`SyntheticEvent.source` と同じ host-bound 原則）。
   * custom trigger は `event.agent === "codex"` のように分岐できる。
   */
  readonly agent: string | null;
  /**
   * phase 固有の付加情報。型は match 側で cast する（`unknown`）。
   *
   * 推奨 field（強制はしない）: `runId`（同一 loop run の相関）、`goal`、
   * `iteration`（number）、`milestone`（progress-milestone の label）、
   * `reason`（failed / blocked-on-approval の理由）。
   *
   * NOTE: 将来 repo-scoped recovery のため repo 変更の手がかり（changed
   * files / commit SHA 等）を載せられるが、loop event 自体は restore を
   * 起こさない。Charminal 自身の復元（history_*）とは別軸。
   * 詳細: docs/decisions/loop-presence-layer.md
   */
  readonly detail?: unknown;
  readonly timestamp: number;
}

/**
 * Handler 発 event。runtime が観測する環境 event ではなく、
 * persona / amenity の handler が `ctx.emitEvent(name, payload)` で
 * 自ら runtime に投入する「合成 event」。
 *
 * ## なぜ存在するのか
 *
 * Charminal の反応 flow は declarative である：
 * **event → trigger.match → reaction → handler**。
 * handler 内から直接 reaction を emit する API（`ctx.emit(reaction)` 的な
 * もの）は意図的に提供していない。そうすると imperative になり、
 * trigger の composability（複数 pack が同じ event を独立に解釈できる性質）
 * が壊れるため。
 *
 * では、amenity handler が `system.exec` の結果から「deploy が失敗した」と
 * 気付いたとき、どうやって persona を悲しませるのか？
 * → handler は直接「悲しませる」のではなく、**観察した事実を announce** する。
 * `ctx.emitEvent('deploy-failed', { exitCode, stderr })` を呼ぶと、runtime は
 * 通常の trigger loop に `SyntheticEvent` を投入する。同じ pack の custom
 * trigger が `kind === 'synthetic'` を match して `'distressed'` のような
 * 標準 reaction を emit し、persona 側の `reflex.responses['distressed']`
 * が発火する（twin-trigger idiom、revelation 3.17）。
 *
 * ## flow
 *
 * 1. handler が何かを観察（例：`deploy.sh` が exitCode != 0 を返した）
 * 2. `ctx.emitEvent('deploy-failed', { exitCode, stderr })` で announce
 * 3. runtime が `SyntheticEvent { kind: 'synthetic', name: 'deploy-failed', ... }`
 *    を生成し、通常の event queue に投入
 * 4. custom trigger が match → reaction を emit → handler が動く
 *
 * ## 命名規約
 *
 * `name` は `'<packId>:<eventName>'` 形式を推奨する（例：
 * `'celebrate-and-deploy:deploy-failed'`）。pack 間の衝突を避けるため。
 * ただし runtime は enforce しない——short name（`'deploy-failed'`）も
 * 動作する。`ctx.emitEvent` 側で packId の prefix を自動付与する可能性は
 * 将来の改良余地。
 */
export interface SyntheticEvent {
  readonly kind: "synthetic";
  /**
   * 発行元のメタデータ。**runtime が `ctx.emitEvent` 呼び出し時に
   * 自動で埋める**（handler 側が指定する必要はない、できない）。
   *
   * 実装上は runtime が pack load 時に **per-pack bound context** を
   * 生成し、`emitEvent` の closure に `{ type, packId }` を capture する。
   * handler からこの source を差し替える経路は存在しない（bound 済み）。
   *
   * pack の追跡・debugging・log attribution に使う。
   */
  readonly source: {
    readonly type: "persona" | "system";
    readonly packId: string;
  };
  /**
   * event 名。`'<packId>:<eventName>'` 形式を推奨するが強制はしない。
   * custom trigger の match 関数で `event.name === 'deploy-failed'` のように
   * 参照する。
   */
  readonly name: string;
  /**
   * 任意の付加情報。handler が観察した事実を custom trigger に
   * 伝えるチャネル。型は任意（match 関数側で自分で cast する）。
   */
  readonly payload?: unknown;
  /**
   * event 生成時刻（ms epoch）。
   * **`ctx.emitEvent` 呼び出し時点の `time.now()` を runtime が自動補填する**。
   * dispatch の timing（custom trigger match と handler 起動の実時刻）とは
   * 独立で、観察された observation の瞬間を表す。
   * cooldown 計測、log ordering、replay など downstream の計算はすべて
   * この timestamp を基準にする。
   */
  readonly timestamp: number;
}

// ─── Trigger system ────────────────────────────────────────

/**
 * Custom trigger 定義。persona / amenity が独自に追加できる。
 *
 * Persona の reflex.customTriggers と Amenity の customTriggers の両方で使う。
 * 環境 event を受けて、match すれば反応を発火する。
 */
export interface Trigger {
  readonly id: string;
  /** 複数 trigger が同じ event に match したときの優先度（大きいほど先） */
  readonly priority?: number;
  /**
   * event が発火に該当するか判定する。
   *
   * - 該当しない場合は null を返す
   * - 該当する場合は TriggerMatch を返す（reaction と payload を指定）
   *
   * この関数は決定論的であるべき（同じ event に対して同じ答え）。
   * 確率的揺らぎは handler 選択の側で扱う（revelation 3.7）。
   */
  match(event: DispatchEvent): TriggerMatch | null;
}

/**
 * Trigger match の結果。reaction type と、optional な payload を含む。
 * payload は amenity → persona の情報伝達チャネル。
 */
export interface TriggerMatch {
  readonly reaction: ReactionType;
  /**
   * 任意の付加情報。persona handler は ctx.event.payload で受け取れる。
   * 型は amenity が自由に定義できるので `unknown`。
   * 使う側は自分で cast する必要がある（付随課題: 型安全性は TBD）。
   */
  readonly payload?: unknown;
}

/**
 * Handler の `ctx.event` として渡される reaction event。
 * trigger の結果と、発火元の生 event を含む。
 */
export interface ReactionEvent {
  readonly reaction: ReactionType;
  readonly triggeredBy: DispatchEvent;
  readonly payload?: unknown;
  /** 発火元の trigger 定義（built-in の標準 trigger なら null） */
  readonly trigger: Trigger | null;
}
