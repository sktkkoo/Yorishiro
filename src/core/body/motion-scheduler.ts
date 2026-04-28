/**
 * MotionScheduler — body motion の priority queue (pure logic)。
 *
 * Body 配下に置く orchestration layer。THREE.AnimationMixer / VRM 等の
 * runtime には依存せず、`onActivate` / `onDeactivate` の delegate callback
 * 経由で外側に動作を委譲する。これにより mixer 抜きで unit test できる。
 *
 * 設計仕様: internal design-record: 2026-04-29-motion-priority-queue-design.md §2-§4
 *
 * Behavior contracts:
 * - higher priority は active な lower を preempt（lower の completion は
 *   `{ reason: "preempted" }` で resolve）。
 * - lower priority は higher が active のとき即 reject（handle は preempted
 *   state で返り、completion も同 reason で resolve）。`onActivate` は呼ばない。
 * - 同 priority は last-write-wins（前 active を preempted で resolve、新 req を active）。
 * - release / cancel / cancelAll で active を解除し、completion は
 *   `{ reason: "cancelled" }` で resolve。
 * - 自然完了（`onActivate` の Promise が解決）時は `{ reason: "completed" }`。
 *
 * Single-active stop model: 現状 preempt は「停めて置き換え」のみ採用しており
 * resume は持たない。`MotionSnapshot.preempted` field は将来の symmetry 確保用に
 * 構造として残しているが、現実装では常に空配列。
 */

/** Motion を発行した主体。 */
export type MotionSource = "reflex" | "mcp" | "persona" | "idle" | "state" | "system";

/**
 * Motion の優先度 tag。numeric value は内部で `PRIORITY_LEVEL` に map され、
 * 大きいほど優先される（preempts lower）。
 */
export type MotionPriority =
  | "critical-reflex"
  | "mcp-conscious"
  | "persona-handler"
  | "state-driven"
  | "idle-fidget";

/**
 * 比較用 numeric level。値が大きいほど優先度が高い。
 *
 * 同値での比較ルール: 「>=」が preempt 条件 → 同 priority も last-write-wins で
 * 置換される（spec §4 contract 5）。
 */
const PRIORITY_LEVEL: Record<MotionPriority, number> = {
  "critical-reflex": 5,
  "mcp-conscious": 4,
  "persona-handler": 3,
  "state-driven": 2,
  "idle-fidget": 1,
};

/** Motion 起動時の補助 option。fade / loop / speed 等の表現 parameter。 */
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
  readonly animation: string;
  readonly options?: MotionOptions;
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
 * `preempted` field は spec §3 で symmetry 確保のため field として保持しているが、
 * 現実装の single-active stop model では常に空。
 */
export interface MotionSnapshot {
  readonly active: MotionEntry | null;
  readonly preempted: ReadonlyArray<MotionEntry>;
}

/** Handle の completion を区別するための reason。 */
export type CompletionReason = "completed" | "cancelled" | "preempted";

/**
 * `request()` が返す handle。caller はこれで motion の release / cancel /
 * 状態確認 / 完了 await を行う。
 */
export interface MotionHandle {
  readonly source: MotionSource;
  readonly priority: MotionPriority;
  readonly animation: string;
  readonly startedAt: number;
  /** 自発的に止める。fadeMs 省略時は default 250。completion は cancelled。 */
  release(fadeMs?: number): void;
  /** 即時停止（fade=0）。completion は cancelled。 */
  cancel(): void;
  /** いま active か（preempted / released / completed では false）。 */
  isActive(): boolean;
  /** higher priority に押し退けられた / lower で reject された場合 true。 */
  isPreempted(): boolean;
  /** 完了を await できる Promise。reason で完了種別を区別する。 */
  readonly completion: Promise<{ reason: CompletionReason }>;
}

/**
 * Body 側 wiring 点。
 * - `onActivate` は実 mixer に clip を載せる。返す Promise は自然完了で resolve。
 * - `onDeactivate` は active clip を fade-out で停止する。
 * - `now` は `startedAt` の決定論性確保のため抽象化（test で固定可能）。
 */
export interface MotionSchedulerCallbacks {
  readonly onActivate: (req: MotionRequest) => Promise<void>;
  readonly onDeactivate: (fadeMs: number) => void;
  readonly now: () => number;
}

interface InternalSlot {
  readonly request: MotionRequest;
  readonly startedAt: number;
  readonly resolveCompletion: (result: { reason: CompletionReason }) => void;
  readonly handle: MotionHandle;
  state: "active" | "preempted" | "released";
}

/** Default fade values (ms)。spec §3 「Defaults」参照。 */
const DEFAULT_FADE_OUT_MS = 250;
const DEFAULT_CANCEL_FADE_MS = 250;
const DEFAULT_CANCEL_ALL_FADE_MS = 200;

export class MotionScheduler {
  private currentSlot: InternalSlot | null = null;

  constructor(private readonly callbacks: MotionSchedulerCallbacks) {}

  /**
   * 新規 motion を要求する。priority に応じて preempt / 置換 / reject を判定。
   *
   * - active より低い priority → 即 reject（handle は preempted state で返る）。
   * - active と同 or 高い priority → 旧 active を preempted で解決し、新 req を active 化。
   * - active が無い → そのまま active 化。
   */
  request(req: MotionRequest): MotionHandle {
    const newLevel = PRIORITY_LEVEL[req.priority];
    const current = this.currentSlot;

    if (current && current.state === "active") {
      const currentLevel = PRIORITY_LEVEL[current.request.priority];
      if (newLevel < currentLevel) {
        // 新 req は lower → 即 reject（preempted 扱い）。
        return this.makeRejectedHandle(req);
      }
      // 新 req は same or higher → 現 active を preempt。
      this.preemptCurrent(req.options?.fadeOutMs ?? DEFAULT_FADE_OUT_MS);
    }

    return this.activateNew(req);
  }

  /**
   * 全 active を停止する（fade-out 付き）。spec の `cancelAll()` 相当。
   * fadeMs 省略時は 200ms。
   */
  cancelAll(fadeMs: number = DEFAULT_CANCEL_ALL_FADE_MS): void {
    const slot = this.currentSlot;
    if (!slot || slot.state !== "active") {
      return;
    }
    slot.state = "released";
    this.currentSlot = null;
    this.callbacks.onDeactivate(fadeMs);
    slot.resolveCompletion({ reason: "cancelled" });
  }

  /** 現 active 状態の snapshot（read-only）。observability 用。 */
  getSnapshot(): MotionSnapshot {
    const slot = this.currentSlot;
    if (!slot || slot.state !== "active") {
      return { active: null, preempted: [] };
    }
    return {
      active: {
        source: slot.request.source,
        priority: slot.request.priority,
        animation: slot.request.animation,
        startedAt: slot.startedAt,
      },
      preempted: [],
    };
  }

  // ─── Internal ──────────────────────────────────────────

  private preemptCurrent(fadeMs: number): void {
    const slot = this.currentSlot;
    if (!slot || slot.state !== "active") {
      return;
    }
    slot.state = "preempted";
    this.currentSlot = null;
    this.callbacks.onDeactivate(fadeMs);
    slot.resolveCompletion({ reason: "preempted" });
  }

  private activateNew(req: MotionRequest): MotionHandle {
    const startedAt = this.callbacks.now();

    let resolveCompletion!: (result: { reason: CompletionReason }) => void;
    const completion = new Promise<{ reason: CompletionReason }>((resolve) => {
      resolveCompletion = resolve;
    });

    // settle ガード: 一度しか resolve しない。
    let settled = false;
    const safeResolve = (result: { reason: CompletionReason }): void => {
      if (settled) return;
      settled = true;
      resolveCompletion(result);
    };

    const slot: InternalSlot = {
      request: req,
      startedAt,
      resolveCompletion: safeResolve,
      // handle は後で field として埋める（自己参照のため）。
      handle: undefined as unknown as MotionHandle,
      state: "active",
    };

    const handle: MotionHandle = {
      source: req.source,
      priority: req.priority,
      animation: req.animation,
      startedAt,
      completion,
      release: (fadeMs?: number): void => {
        this.releaseSlot(slot, fadeMs ?? DEFAULT_CANCEL_FADE_MS);
      },
      cancel: (): void => {
        this.releaseSlot(slot, 0);
      },
      isActive: (): boolean => slot.state === "active",
      isPreempted: (): boolean => slot.state === "preempted",
    };

    // self-reference を埋める。
    (slot as { handle: MotionHandle }).handle = handle;

    this.currentSlot = slot;

    // mixer 起動。Promise の natural resolve は完了 signal として扱う。
    this.callbacks
      .onActivate(req)
      .then(() => {
        // この slot がまだ active なら自然完了。
        if (slot.state === "active") {
          slot.state = "released";
          if (this.currentSlot === slot) {
            this.currentSlot = null;
          }
          safeResolve({ reason: "completed" });
        }
      })
      .catch(() => {
        // load 失敗等。3 種 reason (completed / cancelled / preempted) のどれにも
        // 厳密には該当しないが、活動 not bumped / not user-cancelled の中で最も近い
        // semantics として "completed" を採用。Phase γ で MCP 経由 caller に
        // 失敗を伝える要件が出たら "errored" 4th reason を spec に追加検討。
        if (slot.state === "active") {
          slot.state = "released";
          if (this.currentSlot === slot) {
            this.currentSlot = null;
          }
          safeResolve({ reason: "completed" });
        }
      });

    return handle;
  }

  private releaseSlot(slot: InternalSlot, fadeMs: number): void {
    if (slot.state !== "active") {
      return;
    }
    slot.state = "released";
    if (this.currentSlot === slot) {
      this.currentSlot = null;
    }
    this.callbacks.onDeactivate(fadeMs);
    slot.resolveCompletion({ reason: "cancelled" });
  }

  /**
   * Higher が active な状況で lower priority req が来た場合に返す handle。
   * 受理されず、最初から preempted state として扱う。
   */
  private makeRejectedHandle(req: MotionRequest): MotionHandle {
    const startedAt = this.callbacks.now();
    const completion: Promise<{ reason: CompletionReason }> = Promise.resolve({
      reason: "preempted" as CompletionReason,
    });
    return {
      source: req.source,
      priority: req.priority,
      animation: req.animation,
      startedAt,
      completion,
      release: (): void => {
        /* already settled */
      },
      cancel: (): void => {
        /* already settled */
      },
      isActive: (): boolean => false,
      isPreempted: (): boolean => true,
    };
  }
}
