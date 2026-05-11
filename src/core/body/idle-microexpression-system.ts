/**
 * IdleMicroexpressionSystem — idle 中の Fcl_* morph 微震え。
 *
 * 目的：「神経の入った顔」を作る反射層。表情を雄弁にする目的ではない。
 * 真顔のまま顔の各部位が常時微振動していることで実在性が立ち上がる。
 * 持続 / 振幅 / 周期は「感触 parameter」のため帰納的に調整する初期値で
 * 置いてある（memory: feedback_inductive_tuning_params.md）。
 *
 * Pool は Hana Tool (VRoid) 系の Fcl_* morph を採用。Perfect Sync 版 VRM
 * に差し替えた段階で AU 単位の morph 名に組み替える余地あり。
 *
 * Body は本 system の出力 ({morph, weight} | null) を ExpressionManager の
 * (source: "idle", kind: "custom") slot に 1 つ流す。idle 優先度なので
 * persona/mcp の意図的な expression が来れば自然に suppressed される。
 */

// 周期。1 episode 間の cooldown 範囲。
const NEXT_MIN_S = 1.5;
const NEXT_MAX_S = 4.0;

// 1 episode の持続範囲。fade in/out を含む total 時間。
const DURATION_MIN_S = 0.25;
const DURATION_MAX_S = 0.5;

// fade window。fade in と fade out が三角形を作る。
const FADE_S = 0.12;

// 振幅範囲。雄弁化を避けるため意図的に低く抑える。
const WEIGHT_MIN = 0.04;
const WEIGHT_MAX = 0.12;

/**
 * 微震え対象の morph pool — region 別。
 *
 * Body は brow / eye / mouth ごとに独立した IdleMicroexpressionSystem を持ち、
 * それぞれ独立したタイマー・randomness で micro event を emit する。実際の顔は
 * 各部位の筋肉が独立に微振動するので、3 region 並列が「人形っぽさ」を消す key。
 *
 * Asymmetric (左右非対称) を意図的に含める：
 * - 目: Fcl_EYE_Close_L/R, Fcl_EYE_Joy_L/R で片目だけの動き
 * - 口: Fcl_MTH_SkinFung_L/R で片側だけの smirk
 *
 * Mouth pool は viseme (Fcl_MTH_A/I/U/E/O) を含まない。それは lip sync の責務。
 * 代わりに muscle-level (Small/Close/Up/Down) と emotion (Joy/Angry) を採用し、
 * 音声がない時の「口の生きてる感」を作る。
 */

/** 眉領域 — 思案 / 気付き / 関心 / 驚きの萌芽。 */
export const MICRO_BROW_POOL: ReadonlyArray<string> = [
  "Fcl_BRW_Angry",
  "Fcl_BRW_Joy",
  "Fcl_BRW_Sorrow",
  "Fcl_BRW_Surprised",
];

/** 目領域 — 見開き、軽い squint、片目だけの動きで asymmetric を作る。 */
export const MICRO_EYE_POOL: ReadonlyArray<string> = [
  "Fcl_EYE_Spread",
  "Fcl_EYE_Sorrow",
  "Fcl_EYE_Close_L",
  "Fcl_EYE_Close_R",
  "Fcl_EYE_Joy_L",
  "Fcl_EYE_Joy_R",
];

/** 口領域 — silent な口の動き。への字 / 微笑 / 片側 smirk を含む。 */
export const MICRO_MOUTH_POOL: ReadonlyArray<string> = [
  "Fcl_MTH_Small",
  "Fcl_MTH_Close",
  "Fcl_MTH_Up",
  "Fcl_MTH_Down",
  "Fcl_MTH_Joy",
  "Fcl_MTH_Angry",
  "Fcl_MTH_SkinFung_L",
  "Fcl_MTH_SkinFung_R",
];

/**
 * Backward-compat aggregate — 既存 import 互換のため残す。
 * 新規 callsite は region 別 pool を使うこと。
 */
export const MICRO_MORPH_POOL: ReadonlyArray<string> = [
  ...MICRO_BROW_POOL,
  ...MICRO_EYE_POOL,
  ...MICRO_MOUTH_POOL,
];

export interface MicroexpressionEvent {
  readonly morph: string;
  readonly weight: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export class IdleMicroexpressionSystem {
  private nextTimer: number;
  private activeTimer = 0;
  private activeDuration = 0;
  private activeWeight = 0;
  private activeMorph: string | null = null;
  private currentEvent: MicroexpressionEvent | null = null;
  private enabled = true;

  private readonly random: () => number;
  private readonly morphPool: ReadonlyArray<string>;

  constructor(random?: () => number, morphPool?: ReadonlyArray<string>) {
    this.random = random ?? Math.random;
    this.morphPool = morphPool ?? MICRO_MORPH_POOL;
    this.nextTimer = this.pickNextDelay();
  }

  /**
   * 時間を進めて、現在 frame の microexpression event を返す。
   * enabled=false なら state を即座に clear して null を返す。
   */
  update(delta: number, enabled: boolean): MicroexpressionEvent | null {
    if (!enabled) {
      if (this.enabled) {
        // ちょうど disable された frame で次回 delay を再 sample しておく
        this.nextTimer = this.pickNextDelay();
      }
      this.enabled = false;
      this.clearActive();
      this.currentEvent = null;
      return null;
    }
    if (delta <= 0) return this.currentEvent;
    this.enabled = true;

    if (this.activeDuration <= 0) {
      this.nextTimer -= delta;
      if (this.nextTimer <= 0) {
        this.startEpisode();
      }
    } else {
      this.activeTimer -= delta;
      if (this.activeTimer <= 0) {
        this.clearActive();
        this.nextTimer = this.pickNextDelay();
        this.currentEvent = null;
        return null;
      }
    }

    if (this.activeMorph) {
      this.currentEvent = {
        morph: this.activeMorph,
        weight: this.getStrength() * this.activeWeight,
      };
    } else {
      this.currentEvent = null;
    }
    return this.currentEvent;
  }

  /** Body の updateRelaxed と同様に、外部から最新値を query できる。 */
  get value(): MicroexpressionEvent | null {
    return this.currentEvent;
  }

  get isActive(): boolean {
    return this.activeDuration > 0;
  }

  private startEpisode(): void {
    this.activeDuration = DURATION_MIN_S + this.random() * (DURATION_MAX_S - DURATION_MIN_S);
    this.activeTimer = this.activeDuration;
    this.activeWeight = WEIGHT_MIN + this.random() * (WEIGHT_MAX - WEIGHT_MIN);
    const idx = Math.min(
      Math.floor(this.random() * this.morphPool.length),
      this.morphPool.length - 1,
    );
    this.activeMorph = this.morphPool[idx] ?? null;
  }

  private clearActive(): void {
    this.activeTimer = 0;
    this.activeDuration = 0;
    this.activeWeight = 0;
    this.activeMorph = null;
  }

  private pickNextDelay(): number {
    return NEXT_MIN_S + this.random() * (NEXT_MAX_S - NEXT_MIN_S);
  }

  /**
   * Fade in/out window で三角形 envelope を作る。
   * 短い episode (duration < 2*FADE_S) でも対応するように fade window を縮める。
   */
  private getStrength(): number {
    if (this.activeDuration <= 0) return 0;
    const elapsed = this.activeDuration - this.activeTimer;
    const fadeWindow = Math.min(FADE_S, this.activeDuration / 2);
    const fadeIn = clamp(elapsed / fadeWindow, 0, 1);
    const fadeOut = clamp(this.activeTimer / fadeWindow, 0, 1);
    return Math.min(fadeIn, fadeOut);
  }
}
