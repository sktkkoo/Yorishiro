/**
 * @charminal/sdk/reaction
 *
 * 反応の語彙と trigger system の型定義。
 *
 * ReactionType は persona と harness の共通 contract。
 * harness が custom trigger で event を ReactionType に変換し、
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
 * harness が独自 reaction を定義する場合は custom 文字列を使う。
 * 例: 'build-completed', 'test-passed', 'deploy-failed'
 */
export type ReactionType = StandardReactionType | (string & {});

// ─── Dispatch events ────────────────────────────────────

/**
 * Charminal runtime の trigger loop を流れる event の総称。
 * custom trigger の match 関数の入力として渡される。
 *
 * 「Dispatch」は runtime が dispatcher 経由で trigger match に流すという
 * 意味。event の発信源は runtime（外来 event）と handler（synthetic event）
 * の両方を含む：
 *
 * - **外来 event**: PTY 出力、hook signal、user 入力、idle 検知、window、
 *   scene 変化、`/charm` command など、runtime が観測して生成するもの
 * - **`SyntheticEvent`**: runtime ではなく persona / harness の handler が
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
export type DispatchEvent =
  | PtyOutputEvent
  | HookSignalEvent
  | UserInputEvent
  | IdleEvent
  | ToolActivityEvent
  | WindowEvent
  | SceneChangeEvent
  | CharmCommandEvent
  | SyntheticEvent;

export interface PtyOutputEvent {
  readonly kind: "pty-output";
  /** PTY から流れてきた生 text（ANSI escape を含む可能性） */
  readonly text: string;
  readonly timestamp: number;
}

export interface HookSignalEvent {
  readonly kind: "hook-signal";
  readonly signal: HookSignal;
  readonly timestamp: number;
}

export interface HookSignal {
  readonly name: "pre-tool-use" | "post-tool-use" | "user-prompt-submit" | "stop" | "notification";
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

/**
 * Handler 発 event。runtime が観測する環境 event ではなく、
 * persona / harness の handler が `ctx.emitEvent(name, payload)` で
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
 * では、harness handler が `system.exec` の結果から「deploy が失敗した」と
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
    readonly type: "harness" | "persona";
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
 * Custom trigger 定義。persona / harness が独自に追加できる。
 *
 * Persona の reflex.customTriggers と Harness の customTriggers の両方で使う。
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
 * payload は harness → persona の情報伝達チャネル。
 */
export interface TriggerMatch {
  readonly reaction: ReactionType;
  /**
   * 任意の付加情報。persona handler は ctx.event.payload で受け取れる。
   * 型は harness が自由に定義できるので `unknown`。
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
