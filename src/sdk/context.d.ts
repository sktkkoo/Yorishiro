/**
 * @charminal/sdk/context
 *
 * 2 つの context 型：PersonaContext / EffectContext
 * （機能設備は AmenityContext が担う）
 *
 * 型レベルで境界が強制される：
 *   - PersonaContext は system API を持たない
 *   - AmenityContext は character/voice/space を持たない（motion-free）
 *   - EffectContext は最小 API のみ
 *
 * これにより pack 作者（AI）が誤って境界を越える code を書くと
 * TypeScript のコンパイルエラーになる。
 *
 * Scene Pack は declarative（handler 無し）なので context 型を持たない。
 * Scene の宣言型は `./scene-pack.d.ts` の `ScenePackDefinition` を参照。
 */

import type { ReactionEvent } from "./reaction";
import type { HistoryAPI } from "./history";

// ─── PersonaContext ────────────────────────────────────────

/**
 * Persona の reflex handler が受け取る context。
 * presence の全 API を持つが、system API は一切持たない。
 *
 * Persona はキャラクター identity の表現に専念する。
 * 環境への functional な作用（ファイル書き込み、shell 実行、OS 通知）は
 * amenity に任せる（AmenityContext が担う、型レベルで強制される）。
 */
export interface PersonaContext {
  /** 発火した reaction event */
  readonly event: ReactionEvent;

  /** この handler を実行している persona への参照（読み取り専用） */
  readonly persona: PersonaRef;

  /** 独立した時計 */
  readonly time: Time;

  /**
   * Synthetic event を runtime に投入する。
   *
   * handler 内で「観察したこと」（ログから気付いたこと、memory の
   * state 変化、user の振る舞いパターンなど）を event として announce する
   * primitive。投入された event は通常の trigger loop を通り、match した
   * triggers が reaction を emit する。
   *
   * ⚠️ これは reaction を直接 emit する API ではない。reaction は必ず
   * trigger match を経由する（declarative）。handler が「persona を
   * 悲しませる」のような imperative な指示を出すことはできない。
   *
   * ## 正しい使い方
   *
   * 1. handler 内で何かを観察（例：persona memory の `mood.streak` が
   *    閾値を超えた）
   * 2. `ctx.emitEvent('mood-overflow', { streak })` で announce
   * 3. 同じ pack の custom trigger が `'synthetic'` kind + name
   *    `'mood-overflow'` を match し、`'pleased'` など標準 reaction を emit
   * 4. 対応する `reflex.responses['pleased']` handler が動く
   *
   * ## Runtime contract（MVP で runtime が保証する動作）
   *
   * - **Timing**: trigger matching は emit 呼び出しの calling stack で
   *   同期的に走る。match した handler の起動は外来 event と同じ async
   *   scheduler に投入される（fire-and-forget）。emit 側の handler は
   *   block されない
   * - **Timestamp**: `SyntheticEvent.timestamp` は emit 呼び出し時点の
   *   `time.now()` を runtime が自動補填する。dispatch の実時刻ではない
   * - **Cooldown 計測**: 発火した reaction の cooldown 計測 start は emit
   *   時点（= synthetic event の timestamp）
   * - **Source binding**: `SyntheticEvent.source` は runtime が pack load
   *   時に per-pack bound context へ closure capture する。handler 側から
   *   改ざんはできない
   * - **Loop protection**: dispatch chain の depth は runtime が track し、
   *   **MVP constraint: max depth 4** を超えると runtime が log.warn を
   *   残して emit を silently drop する（例外は投げない）。
   *   depth 1 = 外来 event、depth 2-4 = synthetic chain
   *
   * @param name synthetic event の名前。`'<packId>:<eventName>'` 形式を
   *             推奨するが強制はしない
   * @param payload 任意の付加情報。custom trigger の match 関数で参照できる
   *
   * @see SyntheticEvent for the event shape
   */
  emitEvent(name: string, payload?: unknown): void;

  // ─── Presence output ─────────────────

  readonly character: CharacterAPI;
  readonly voice: VoiceAPI;
  readonly space: SpaceAPI;

  // ─── 共有 utility（neutral、presence でも function でもない）───

  readonly log: LogAPI;
  readonly memory: MemoryAPI;
  readonly terminal: TerminalAPI; // observation only
  readonly charm: CharmAPI;
  readonly signal: AbortSignal; // 中断通知
}

// ─── AmenityContext ────────────────────────────────────────

/**
 * Amenity の activate 関数が受け取る context。
 * system API と共有 utility を持つが、presence API は一切持たない（motion-free）。
 *
 * - `event: ReactionEvent` を持たない（activate は event-driven ではなく lifecycle-driven）
 * - activate の lifecycle に紐づく signal を持つ（disable 時に abort）
 *
 * Amenity は機能設備の提供に専念する。
 * キャラクターの表現は `emitEvent()` → persona reflex 経由で委ねる。
 */
export interface AmenityContext {
  readonly time: Time;
  readonly persona: PersonaRef;

  /**
   * Synthetic event を runtime に投入する。
   * amenity が「何が起きたか」を述べるだけで、「どう反応するか」は
   * persona の reflex が決める。PersonaContext.emitEvent と同一の contract。
   *
   * @param name synthetic event の名前。`'<amenityId>:<eventName>'` 形式を推奨
   * @param payload 任意の付加情報
   */
  emitEvent(name: string, payload?: unknown): void;

  readonly tween: TweenAPI;
  readonly system: SystemAPI;
  /**
   * Pack rollback の history（list / snapshot / restore）。functional capability
   * なので persona ではなく amenity 側に置く（motion-free 境界・system と同列）。
   * restore は破壊的なので実装が確認 UX を gate する。
   */
  readonly history: HistoryAPI;
  readonly log: LogAPI;
  readonly memory: MemoryAPI;
  readonly terminal: TerminalAPI;
  readonly charm: CharmAPI;
  readonly signal: AbortSignal;

  // NOTE: character / voice / space は意図的に存在しない (motion-free)
  // NOTE: event: ReactionEvent も存在しない (activate は event-driven ではない)
}

// ─── EffectContext ─────────────────────────────────────────

/**
 * Effect Pack の runner 関数が受け取る context。
 * 最小の rendering primitive だけ持つ。
 *
 * Effect は passive な rendering unit。persona から呼ばれて実行される。
 * memory も log も system も持たない。呼ばれて、描画して、終わる。
 */
export interface EffectContext<TOptions = unknown> {
  /** persona が ctx.space.injectEffect で渡した options */
  readonly options: TOptions;

  readonly time: Time;
  /** persona が effect を interrupt したときに fire */
  readonly signal: AbortSignal;

  readonly renderer: RendererAPI;
  readonly audio: EffectAudioAPI;

  // NOTE: character / voice / space / system / log / memory は存在しない
  // NOTE: emitEvent も意図的に存在しない。effect は reaction system の
  //       consumer ではなく passive renderer。呼ばれて描画して終わる存在で、
  //       新しい event や reaction を産み出す役割を持たない。effect が
  //       「何か気付いた」ので反応を起こしたい場合は、その観察を行う責任は
  //       呼び出し元の persona handler 側にある。
}

// ============================================================
// 以下、各 API の定義
// ============================================================

// ─── Time ──────────────────────────────────────────────────

export interface Time {
  now(): number;

  /**
   * Promise-based sleep。`await ctx.time.after(500)` の形で使う。
   *
   * handler は async 関数なので、async/await で自然に組める。
   * 「play A → 500ms 待つ → play B」のような sequence はこれで書く。
   *
   * NOTE: これは「反応を遅らせる」ためではなく、handler 内の
   * timing 制御のための sleep。反応の dispatch latency 自体はゼロ。
   *
   * Cancel 可能な schedule が欲しい場合は `schedule()` を使う。
   */
  after(ms: number): Promise<void>;

  /**
   * Callback-based schedule。cancel 可能。
   *
   * handler 外の自発動作を予約する用途。
   * 例: 「3 分 idle したら mischief」「scene load 後 10 秒で挨拶」
   */
  schedule(ms: number, action: () => void): Cancellable;

  /** 周期実行 */
  every(interval: number, action: () => void): Cancellable;

  /**
   * 確率的周期実行。「無操作時のイタズラ」パターン。
   * interval ごとにチェックし、probability で発火。
   */
  probability(opts: { interval: number; probability: number; action: () => void }): Cancellable;

  /**
   * ジッター付き遅延（sleep）。
   * [min, max] の範囲でランダムな ms だけ sleep する。
   *
   * ⚠️ 過剰使用注意。default で使うべきではない。
   * narrow な「連続追従 anti-pattern」への対処としてのみ使う。
   * 詳細は docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「独立した時間の適用範囲」参照。
   */
  afterJitter(min: number, max: number): Promise<void>;
}

export interface Cancellable {
  cancel(): void;
}

// ─── CharacterAPI (persona only) ───────────────────────────

export interface CharacterAPI {
  /**
   * アニメーション再生。
   * 複数の play() は animation lane で primary slot + crossfade で捌かれる。
   * 返される handle で weight / stop の動的制御が可能。
   */
  play(animation: AnimationRef, options?: PlayOptions): AnimationHandle;

  /**
   * 表情。
   *
   * ⚠️ 重要制約：全 active expression の weight 合計は 1 を超えない。
   * 超える場合、Body は proportional に scale down する。
   * handle の effectiveWeight は requestedIntensity と異なりうる。
   * これは lip sync (phoneme) にも同じ予算として適用される。
   */
  express(target: ExpressionTarget, intensity: number): ExpressionHandle;

  /**
   * 視線。
   * Body は default で probabilistic な idle gaze を常時動かしている。
   * gaze() 呼び出しは idle gaze を override する。
   * handle.release() で idle gaze に戻る。
   */
  gaze(target: GazeTarget, options?: GazeOptions): GazeHandle;

  /** 身体の全動作を中断 */
  interrupt(reason?: string): void;
}

/** 既存 asset 参照。例: 'VRMA_small_nod' */
export type AnimationRef = string;

export interface PlayOptions {
  /** フェードインの時間（他アニメとの blend 用） */
  fadeInMs?: number;
  fadeOutMs?: number;
  /** 重み。loop する idle layer などは 0.2-0.4 程度 */
  weight?: number;
  loop?: boolean;
  speed?: number;
  /**
   * Legacy field — MVP では無視される。
   *
   * priority arbitration は MotionScheduler が固定 enum
   * (`MotionPriority`) で管理するようになったため、本 numeric
   * priority は consult されない。互換のため field 自体は残してある。
   *
   * @deprecated Phase γ で MotionRequest API に移行。MVP では無視される。
   *   See: 2026-04-29-motion-priority-queue-design.md §5.4
   */
  priority?: number;
}

export interface AnimationHandle {
  readonly animation: AnimationRef;
  readonly startedAt: number;
  /**
   * @deprecated Priority queue model では weight 変更は no-op + console.warn。
   *   Phase γ で MotionRequest 経由の re-acquire pattern に移行予定。
   *   See: 2026-04-29-motion-priority-queue-design.md §5.1
   */
  setWeight(weight: number, fadeMs?: number): void;
  stop(fadeMs?: number): Promise<void>;
  cancel(): void;
  /** 再生完了を await できる */
  readonly completion: Promise<void>;
}

/**
 * 部位別表情を author する region 識別子。Hana Tool / VRoid 系 VRM の
 * `Fcl_{BRW|EYE|MTH}_*` morph 体系に対応する。眉 / 目 / 口を独立 weight で
 * 動かしたいときに使う。
 */
export type PartRegion = "brow" | "eye" | "mouth";

/**
 * 部位別 emotion 識別子。VRM 0.x 標準 6 group のうち Neutral を除いた 5 種。
 * `Fcl_{BRW|EYE|MTH}_{Angry|Fun|Joy|Sorrow|Surprised}` に対応する。
 */
export type PartEmotion = "angry" | "fun" | "joy" | "sorrow" | "surprised";

export type ExpressionTarget =
  | { kind: "mood"; preset: "happy" | "sad" | "angry" | "relaxed" | "surprised" }
  | { kind: "eye"; variant: "blink" | "blinkL" | "blinkR" | "lookup" | "lookdown" }
  | { kind: "lip"; phoneme: "aa" | "ih" | "ou" | "ee" | "oh" }
  /**
   * 部位 × emotion を 1 つの morph に解決する curated channel。
   * 例: `{ region: "brow", emotion: "sorrow" }` は `Fcl_BRW_Sorrow` を駆動する。
   * region 別の internal slot kind に分解されるため、同 source から
   * 「眉=sorrow / 目=sorrow / 口=sorrow」の 3 slot を並走させて部位合成
   * sadness を author できる。
   */
  | { kind: "part"; region: PartRegion; emotion: PartEmotion }
  | { kind: "custom"; blendShapeName: string };

export interface ExpressionHandle {
  readonly target: ExpressionTarget;
  readonly requestedIntensity: number;
  readonly effectiveWeight: number;
  setIntensity(intensity: number): void;
  release(fadeMs?: number): void;
}

export type GazeTarget =
  | { kind: "point"; direction: Vec3 }
  | { kind: "screen-element"; selector: string }
  | { kind: "camera" }
  | { kind: "text-region"; bounds: Bounds }
  | { kind: "away" };

export interface GazeOptions {
  durationMs?: number;
  transitionMs?: number;
  jitter?: number;
}

export interface GazeHandle {
  readonly target: GazeTarget;
  readonly active: boolean;
  release(): void;
}

// ─── MotionPriorityQueue (Phase γ-adjacent) ───────────────────

/**
 * Body motion の発火 source。state.get で観察可能、residents が自分の motion 構成を読める。
 * - "reflex": 反射層（perception bridge 等）から発火
 * - "mcp": 住人 AI が MCP tool 経由で意識的に発火（Phase γ）
 * - "persona": persona reflex handler 経由（ctx.character.play の caller）
 * - "idle": 30s+ idle の小動作
 * - "state": Body.setState 連動（writing 中の Typing 等）
 * - "system": 内部用（greeting nod 等）
 */
export type MotionSource = "reflex" | "mcp" | "persona" | "idle" | "state" | "system";

/**
 * Motion priority levels（5 段、固定 enum）。higher が lower を preempt する。
 * - "critical-reflex" (L5): 強制割り込み（startle / flinch、MVP では未使用枠）
 * - "mcp-conscious" (L4): 住人 AI の意思
 * - "persona-handler" (L3): persona reflex の演技 motion
 * - "state-driven" (L2): state 連動 (Typing during writing 等)
 * - "idle-fidget" (L1): 30s+ idle の小動作
 *
 * "default-pose" は queue 外（active が無いとき procedural-bones + breathing が default）、
 * priority enum には含めない。acquireMotionSlot で渡せない設計。
 */
export type MotionPriority =
  | "critical-reflex"
  | "mcp-conscious"
  | "persona-handler"
  | "state-driven"
  | "idle-fidget";

/** Motion 起動時の補助 option（fade / loop / speed 等の表現 parameter）。 */
export interface MotionOptions {
  readonly fadeInMs?: number;
  readonly fadeOutMs?: number;
  readonly weight?: number;
  readonly loop?: boolean;
  readonly speed?: number;
}

/** Scheduler への motion 依頼。priority と animation 識別子を含む。 */
export interface MotionRequest {
  readonly source: MotionSource;
  readonly priority: MotionPriority;
  readonly animation: AnimationRef;
  readonly options?: MotionOptions;
}

/** Handle の completion を区別するための reason。 */
export type MotionCompletionReason = "completed" | "cancelled" | "preempted" | "errored";

/**
 * `acquireMotionSlot()` が返す handle。caller はこれで motion の release / cancel /
 * 状態確認 / 完了 await を行う。
 */
export interface MotionHandle {
  readonly source: MotionSource;
  readonly priority: MotionPriority;
  readonly animation: AnimationRef;
  readonly startedAt: number;
  release(fadeMs?: number): void;
  cancel(): void;
  isActive(): boolean;
  isPreempted(): boolean;
  /** 自然完了 / cancel / preempt のいずれか。reject はしない。 */
  readonly completion: Promise<{ readonly reason: MotionCompletionReason }>;
}

/** Snapshot 観察用の active / preempted entry の read-only 形。 */
export interface MotionEntry {
  readonly source: MotionSource;
  readonly priority: MotionPriority;
  readonly animation: string;
  readonly startedAt: number;
}

/**
 * Scheduler 状態の snapshot（observability で使う）。
 * `preempted` field は単一 active stop model のため現状常に空、symmetry のため field 保持。
 */
export interface MotionSnapshot {
  readonly active: MotionEntry | null;
  /** Stop model のため現状常に空、symmetry のため field 保持 */
  readonly preempted: ReadonlyArray<MotionEntry>;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/**
 * 2 次元ベクトル。用途によって座標系が異なる点に注意。
 *
 * - `SpaceEffectRequest` の `origin` として渡す場合は **正規化座標系
 *   (0-1 範囲、左上原点)**。詳しくは `SpaceEffectRequest` の JSDoc を参照。
 * - その他の用途（e.g. offset、delta、velocity）は文脈依存。
 */
export interface Vec2 {
  x: number;
  y: number;
}
export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// ─── VoiceAPI (persona only) ───────────────────────────────

export interface VoiceAPI {
  /** TTS 発話（思考層から) */
  say(text: string, options?: SayOptions): VoiceHandle;

  /**
   * Pre-recorded clip を再生する。
   *
   * `clipRef` は 3 種類を支援：
   * - `voice:<stem>` — 共有 voice library（`bundled-packs/shared/voices/`）
   * - `./...` / `assets/...` — persona pack 同梱の WAV
   * - `http(s)://`, `asset://`, `blob:` — caller が解決済みの URL
   *
   * 解決失敗は silent ではなく、returned VoiceHandle の `completion` が reject する。
   * `startedAt` は `0` のまま。caller は「鳴っていない」を検知できる。
   *
   * @param clipRef 再生対象の clip reference。解決規約は docs/decisions/voice-clip-resolution.md 参照
   * @param options 再生オプション（volume など）
   *
   * @returns VoiceHandle。startedAt, stop(), completion を持つ
   *
   * @see docs/decisions/voice-clip-resolution.md 「音声 clip の参照を解決する規約」
   */
  play(clipRef: VoiceClipRef, options?: VoicePlayOptions): VoiceHandle;

  /** 黙らせる */
  silence(fadeMs?: number): void;
}

export type VoiceClipRef = string;

export interface SayOptions {
  speed?: number;
  pitch?: number;
  volume?: number;
}

export interface VoicePlayOptions {
  volume?: number;
}

export interface VoiceHandle {
  readonly startedAt: number;
  stop(fadeMs?: number): Promise<void>;
  readonly completion: Promise<void>;
}

// ─── SpaceAPI (persona only) ───────────────────────────────

export interface SpaceAPI {
  /**
   * Effect を空間に注入する。
   * kind は built-in effect id または user Effect Pack の id。
   */
  injectEffect(request: SpaceEffectRequest): SpaceEffectHandle;
}

/**
 * Effect の呼び出し request。
 * kind には built-in effect 名（'shake', 'flash', 'particles', 'fireworks',
 * 'text-physics' など）、または user Effect Pack の id を指定する。
 * options は effect 固有のパラメータ。
 *
 * ## `origin` の座標系
 *
 * `particles` / `fireworks` / `text-physics` などが持つ `origin: Vec2` は
 * **正規化座標系 (0-1 範囲)** で指定する。画面の物理 pixel サイズには
 * 依存しない——runtime 側で各 renderer に合わせて変換される。
 *
 * - `{ x: 0, y: 0 }`     → 画面左上
 * - `{ x: 1, y: 0 }`     → 画面右上
 * - `{ x: 0, y: 1 }`     → 画面左下
 * - `{ x: 1, y: 1 }`     → 画面右下
 * - `{ x: 0.5, y: 0.5 }` → 画面中心
 *
 * 範囲外の値（negative や > 1）も technically 許容される（画面外から
 * 飛び込んでくる演出など）が、default は 0-1 の範囲で考えること。
 */
export type SpaceEffectRequest =
  | { kind: "screen-shake"; intensity: number; durationMs: number }
  | { kind: "flash"; color: string; durationMs: number }
  | { kind: "particles"; origin: Vec2; count: number; durationMs: number; colorScheme?: string }
  | { kind: "fireworks"; origin: Vec2; count: number; durationMs: number }
  | {
      kind: "fireworks-volley";
      count?: number;
      originRange?: { x: [number, number]; y: [number, number] };
      delayStepMs?: number;
      delayJitterMs?: number;
      burstCount?: number;
      burstDurationMs?: number;
    }
  | { kind: "text-physics"; origin: Vec2; force: number; gravity?: number }
  | {
      kind: "camera-move";
      durationMs?: number;
      holdMs?: number;
      restoreMs?: number;
      offset?: Partial<Vec3>;
      fovOffset?: number;
      lookAt?: Vec3;
    }
  | { kind: "desaturate"; durationMs: number; intensity?: number }
  | { kind: string; [option: string]: unknown }; // user effect への拡張

export interface SpaceEffectHandle {
  readonly kind: string;
  readonly startedAt: number;
  readonly completion: Promise<void>;
  cancel(): void;
}

// ─── SystemAPI (amenity only) ──────────────────────────────

export interface SystemAPI {
  /** shell コマンドを実行して完了を待つ */
  exec(command: string, options?: ExecOptions): Promise<ExecResult>;

  /** 長時間走るプロセスを spawn */
  spawn(command: string, options?: SpawnOptions): ProcessHandle;

  /** ファイルシステム */
  readonly fs: SystemFsAPI;

  /** OS 通知 */
  notify(opts: NotifyOptions): Promise<NotifyResponse>;
}

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  input?: string;
}

export interface ExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface SpawnOptions extends ExecOptions {
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcessHandle {
  readonly pid: number;
  kill(signal?: "SIGINT" | "SIGTERM" | "SIGKILL"): void;
  readonly completion: Promise<ExecResult>;
}

export interface SystemFsAPI {
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
}

export interface NotifyOptions {
  title: string;
  body?: string;
  icon?: string;
  /** 通知にボタンを付ける場合 */
  actions?: ReadonlyArray<string>;
}

export interface NotifyResponse {
  /** 通知が表示されたか */
  readonly shown: boolean;
  /** user がクリックしたアクション（なければ null） */
  readonly clickedAction: string | null;
}

// ─── LogAPI (shared) ───────────────────────────────────────

export interface LogAPI {
  /** reaction ログを書く */
  write(entry: LogEntryWrite): void;
  /** 直近 N 件を読む（noticed フラグは立つ） */
  tail(count: number): ReadonlyArray<LogEntry>;
  /** フィルタ付き検索 */
  read(filter?: LogFilter): ReadonlyArray<LogEntry>;
}

export interface LogEntryWrite {
  reaction: string;
  note?: string;
  data?: unknown;
}

export interface LogEntry extends LogEntryWrite {
  readonly timestamp: number;
  readonly personaId: string;
  readonly noticed: boolean;
}

export interface LogFilter {
  since?: number;
  personaId?: string;
  reactionType?: string;
  limit?: number;
}

// ─── MemoryAPI (shared) ────────────────────────────────────

export interface MemoryAPI {
  /** persona 固有の memory（active な persona だけが参照可能） */
  readonly persona: MemoryScope;
  /** Charminal 本体の core memory（persona 非依存） */
  readonly core: MemoryScope;
}

export interface MemoryScope {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
}

// ─── TerminalAPI (shared, observation only) ───────────────

/**
 * PTY 観察用 API。
 *
 * ⚠️ 書き込み API は意図的に存在しない（revelation 3.13）。
 * Charminal は Claude Code の judgment loop に一切介入しない。
 */
export interface TerminalAPI {
  /** 直近の PTY 出力 text を読む（観察のみ） */
  output(lastN?: number): string;
  /** 現在のセッション metadata */
  readonly session: {
    readonly pid: number;
    readonly cwd: string;
    readonly startedAt: number;
  };
}

// ─── CharmAPI (shared) ─────────────────────────────────────

/** charm コマンド（/charm:create 等）を発火するための API */
export type CharmAPI = (command: string) => Promise<void>;

// ─── RendererAPI (effect only) ─────────────────────────────

export interface RendererAPI {
  /** パーティクル system を追加 */
  addParticles(config: ParticleConfig): ParticleHandle;
  /** Three.js camera を一時的に動かし、完了後に元の状態へ戻す */
  addCameraMove(config: CameraMoveConfig): Disposable;
  /** Canvas に直接描画 */
  drawOnCanvas(draw: (ctx: CanvasRenderingContext2D) => void): Disposable;
  /** DOM overlay layer を追加。container 内で自由に DOM 操作可能 */
  addDomLayer(setup: (container: HTMLDivElement) => void): Disposable;
  /** 画面振動フィルタを追加 */
  addShakeFilter(intensity: number): Disposable;
  /** CSS filter を画面全体に適用（grayscale / blur / sepia / brightness 等）。
   *  複数同時に呼べる（filter 値は space-separated で合成される）。 */
  addCssFilter(filter: string): Disposable;
  /** xterm.js の visible cells を読み取る（TextPhysics 用）。未接続なら null */
  queryTerminalCells(): TerminalCellData | null;
}

export interface CameraMoveConfig {
  /** move-out にかける時間（ms） */
  readonly durationMs: number;
  /** target 位置で保持する時間（ms）。default 0 */
  readonly holdMs?: number;
  /** 元の camera state に戻す時間（ms）。default は durationMs */
  readonly restoreMs?: number;
  /** 現在位置からの相対移動量。zoom out は通常 `{ z: positive }` */
  readonly offset?: Partial<Vec3>;
  /** 現在 FOV からの相対変化量。positive で広角化 = zoom out */
  readonly fovOffset?: number;
  /** 指定時は各 frame でこの点を見る。未指定時は runtime default target を使う */
  readonly lookAt?: Vec3;
}

/**
 * ターミナルの visible 行のセルデータ。TextPhysics 等の effect が
 * ターミナルの文字を overlay 上に複製して物理演算を適用するために使う。
 * Renderer.queryTerminalCells() から取得する。
 */
export interface TerminalCellData {
  readonly cells: ReadonlyArray<{
    readonly char: string;
    /** terminal left からの pixel offset */
    readonly x: number;
    /** terminal top からの pixel offset */
    readonly y: number;
    readonly row: number;
    readonly col: number;
    readonly fgColor: string;
  }>;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly terminalRect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
  readonly cols: number;
  readonly rows: number;
}

export interface ParticleConfig {
  /**
   * パーティクルの発生原点。`SpaceEffectRequest.origin` と同じ
   * **正規化座標系 (0-1 範囲、左上原点)** を使う。
   */
  origin: Vec2;
  count: number;
  durationMs: number;
  /**
   * 配色テーマ。以下は runtime が built-in で認識する scheme：
   *
   * - `'white'`       — 白の単色
   * - `'gold'`        — 金色
   * - `'white-gold'`  — 白 + 金のグラデーション
   * - `'silver'`      — 銀色
   * - `'rainbow'`     — 虹色
   * - `'monochrome'`  — 単色グレースケール
   *
   * これに加え、`'mono-<cssColor>'` 形式で動的な単色 scheme を指定できる
   * （例：`'mono-#ff5555'`、`'mono-red'`）。
   *
   * 未指定 or 未知の scheme の場合、runtime は default (`'white'`) に
   * フォールバックする——つまり「unknown でも crash しない」保証はあるが、
   * 意図した色を出したいなら列挙のいずれかを使うこと。
   *
   * 型を `string` にしているのは、user Effect Pack が独自の scheme を
   * 追加できる余地を残すため（closed enum にはしていない）。
   */
  colorScheme?: string;
  speed?: number;
  gravity?: number;
  size?: number;
}

export interface ParticleHandle {
  dispose(): void;
  readonly completion: Promise<void>;
}

export interface Disposable {
  dispose(): void;
}

// ─── AudioAPI (effect only) ────────────────────────────────

/**
 * Effect 専用の audio API。
 * persona の voice とは別（persona voice は TTS / pre-recorded で
 * character の声を表現する、effect audio は SE や BGM）。
 */
export interface EffectAudioAPI {
  /** 音声ファイルを再生（effect の assets/ からの相対パス可） */
  play(ref: string, options?: AudioPlayOptions): Promise<void>;
}

export interface AudioPlayOptions {
  volume?: number;
  loop?: boolean;
}

// ─── TweenAPI (shared) ────────────────────────────────────

/**
 * Per-frame parameter 補間の SDK surface。
 *
 * key ごとに last-write-wins。同 key の新 tween は古い tween を cancel し、
 * 現在値から開始する。pack dispose 時（signal abort）に、その pack が開始した
 * tween は自動的に cancel される。
 *
 * Philosophy: docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「観察の境界」
 * — 身体・空間の変化は連続であるべき。
 */
export interface TweenAPI {
  /** 数値の smooth transition。key ごとに last-write-wins。 */
  start(
    key: string,
    to: number,
    durationMs: number,
    apply: (value: number) => void,
    options?: { from?: number; easing?: (t: number) => number },
  ): TweenHandle;

  /** Vec3 の smooth transition。 */
  startVec3(
    key: string,
    to: readonly [number, number, number],
    durationMs: number,
    apply: (value: [number, number, number]) => void,
    options?: { from?: readonly [number, number, number]; easing?: (t: number) => number },
  ): TweenHandle;

  /** Active tween を key で cancel。 */
  cancel(key: string): void;
}

/**
 * 個別 tween の handle。cancel で即座に止め、completion で完了を await できる。
 * cancel 時も completion は resolve する（reject ではない）。
 */
export interface TweenHandle {
  /** Cancel this tween immediately。 */
  cancel(): void;
  /** Completes when tween finishes naturally or is cancelled。 */
  readonly completion: Promise<void>;
}

// ─── PersonaRef ────────────────────────────────────────────

/** handler context から見える persona の読み取り専用 reference */
export interface PersonaRef {
  readonly id: string;
  readonly name: string;
}
