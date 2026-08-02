/**
 * Body — 身体 primitive。VRM character の actuator 層。
 *
 * Owns all subsystems that manipulate the VRM model:
 * - ExpressionManager: weighted expression blending (SDK budget constraint)
 * - BlinkSystem: autonomous blink generation
 * - EyeSystem: idle saccade/fixation + gaze override
 * - AnimationPlayer: VRMA clip loading + playback
 * - Breathing: sine wave position bob
 *
 * Exposes CharacterAPI for PersonaContext. Drives the render-loop update.
 *
 * SDK surface: src/sdk/context.d.ts CharacterAPI (262-292)
 */

import type { VRM } from "@pixiv/three-vrm";
import type {
  AnimationHandle,
  AnimationRef,
  AttentionSnapshot,
  CharacterAPI,
  Disposable,
  ExpressionHandle,
  ExpressionTarget,
  GazeHandle,
  GazeOptions,
  GazeTarget,
  PlayOptions,
  MotionHandle as SdkMotionHandle,
  MotionRequest as SdkMotionRequest,
  MotionSnapshot as SdkMotionSnapshot,
} from "@yorishiro/sdk";
import { getAttentionRuntime } from "../../runtime/attention-runtime";
import { type ClaimState, getClaimState } from "../../runtime/ui-claim-state";
import type { SubsystemLog } from "../dev-log";
import type { MouthValues } from "../voice/mouth-values";
import { createMouthValues, MOUTH_KEYS } from "../voice/mouth-values";
import { AnimationPlayer } from "./animation-player";
import { defaultProfiles } from "./beat-library";
import { IdleBeatScheduler } from "./beat-scheduler";
import type { BeatTarget } from "./beat-types";
import { BlinkSystem } from "./blink-system";
import { BreathingSystem } from "./breathing-system";
import { CursorAttentionSystem, type MutableCursorAttentionOutput } from "./cursor-attention";
import type {
  AdmittedExpressionIntent,
  ExpressionArbitrationSnapshot,
  ExpressionIntentHandle,
  ExpressionOccupancy,
} from "./expression-intent";
import { ExpressionIntentArbiter } from "./expression-intent-arbiter";
import {
  buildExpressionIntentDebugView,
  type ExpressionIntentDebugView,
} from "./expression-intent-debug";
import {
  BROW_AFFECT_OCCUPANCY,
  EMPTY_OCCUPANCY,
  EYE_AFFECT_OCCUPANCY,
  EYELID_PHYSIOLOGY_OCCUPANCY,
  FULL_FACE_AFFECT_OCCUPANCY,
  MOUTH_AFFECT_OCCUPANCY,
  MOUTH_ARTICULATION_OCCUPANCY,
} from "./expression-intent-policy";
import { ExpressionIntentResolver } from "./expression-intent-resolver";
import { ExpressionIntentSlotBridge } from "./expression-intent-slot-bridge";
import {
  type ExpressionKind,
  ExpressionManager,
  ExpressionSinkTracker,
  type ExpressionSource,
  expressionTargetToKind,
  expressionTargetToName,
  type SlotSnapshot,
} from "./expression-manager";
import { type EyeState, EyeSystem, gazeTargetToAngles, type MutableEyeOutput } from "./eye-system";
import {
  IdleMicroexpressionSystem,
  MICRO_BROW_POOL,
  MICRO_EYE_POOL,
  MICRO_MOUTH_POOL,
  type MicroexpressionEvent,
  type MutableMicroexpressionEvent,
} from "./idle-microexpression-system";
import { IdleSquintSystem } from "./idle-squint-system";
import {
  type MotionHandle as InternalMotionHandle,
  type MotionRequest as InternalMotionRequest,
  MotionScheduler,
} from "./motion-scheduler";
import { ProceduralBones } from "./procedural-bones";
import {
  DEFAULT_SPEECH_MICROEXPRESSION_PARAMS,
  type SpeechMicroexpressionOutput,
  type SpeechMicroexpressionParams,
  SpeechMicroexpressionSystem,
} from "./speech-microexpression-system";
import { SpeechMoodChannel } from "./speech-mood-channel";

// ─── Constants ───────────────────────────────────────────

/** Body が lip sync 値を pull するためのインターフェース。 */
export interface LipSyncSource {
  isMouthActive?(): boolean;
  sampleMouth(out?: MouthValues): MouthValues;
}

export interface SpeechStateExpressionRequest {
  readonly preset?: string;
  readonly intensity?: number;
  readonly microexpressionParams?: Partial<SpeechMicroexpressionParams>;
}

export interface SpeechStateExpressionHandle {
  release(): void;
}

interface SpeechStateExpressionLayer extends SpeechStateExpressionRequest {
  readonly id: number;
}

const BLINK_EXPRESSION_NAME = "blink";
const SPEECH_BROW_EXPRESSION_NAME = "Fcl_BRW_Surprised";
const SPEECH_EYE_EXPRESSION_NAME = "Fcl_EYE_Spread";

// Eye-head coordination：この magnitude 以上の saccade で頭が視線に追従する。
// gain は「目の移動角の何割を頭が肩代わりするか」（人間はおよそ 2〜3 割）。
const HEAD_RECRUITMENT_MIN_MAGNITUDE = 0.6;
const HEAD_RECRUITMENT_GAIN = 0.25;
// beat glance は idle saccade より小振幅でも頭を連れる(eye-lead を見せる)。
// ただし reading/writing は dead-zone 厳守=目だけ。
const GLANCE_HEAD_RECRUITMENT_MIN = 0.08;

// Startle 反射の cooldown。エラーが連発しても痙攣的に反応し続けない
//（motion-effect-trigger-axes.md の「intrusive な motion」の教訓）。
const STARTLE_COOLDOWN_S = 10;
// Startle 時の息止め時間
const STARTLE_BREATH_HOLD_S = 0.5;
const EYELID_REFLEX_ATTACK_MS = 50;
const EYELID_REFLEX_RELEASE_MS = 85;
const SPEECH_BOUNDARY_BLINK_DURATION_MS = 50;
const STARTLE_BLINK_DURATION_MS = 50;

// State-dependent expression targets (ported from old vrmExpressions.ts)
const STATE_EXPRESSIONS: Record<EyeState, ReadonlyArray<[string, number]>> = {
  idle: [["neutral", 1.0]],
  thinking: [["neutral", 0.4]],
  reading: [["neutral", 0.6]],
  writing: [["neutral", 0.3]],
  running: [["neutral", 0.3]],
};

// Gradual relaxed expression after 30s idle (ported from old BodySystem)
const RELAXED_THRESHOLD_S = 30;
const RELAXED_RAMP_S = 10;
const RELAXED_MAX = 0.4; // cap to avoid sleepy-looking eyes

// relaxed は目元を緩める部分表情なので、intent の occupancy は eye/affect
// のみ（full-face にすると state base と categorical 競合してしまう）。
const RELAXED_OCCUPANCY = [{ region: "eye", lane: "affect" }] as const;

function hasMouthSignal(values: MouthValues): boolean {
  for (const key of MOUTH_KEYS) {
    if (values[key] > 0) return true;
  }
  return false;
}

// ─── Body ────────────────────────────────────────────────

export class Body {
  private readonly vrm: VRM;
  private readonly expressions: ExpressionManager;
  /**
   * VRM expressionManager への書き込みを last-frame tracking で管理する sink。
   * VRM 1.0 preset 以外の custom blendshape (Fcl_*, Perfect Sync 等) も
   * slot release 時に確実に 0 へ戻す。
   */
  private readonly expressionSink = new ExpressionSinkTracker();
  private readonly expressionBatch = new Map<string, number>();
  private readonly blinkSystem: BlinkSystem;
  /**
   * 呼吸の生理。state 連動（focused は速く浅く、長 idle は深くゆっくり）、
   * ため息、startle 時の息止めを持つ。出力は scene Y 位置 + 胸郭・肩の
   * 微小回転（後者は ProceduralBones が spine / upperArm に加算合成）。
   */
  private readonly breathing = new BreathingSystem();
  private readonly eyeSystem: EyeSystem;
  /**
   * Idle 中の Fcl_* morph 微震えで実在性を立ち上げる反射層。Region 別に独立
   * instance を持つ：brow / eye / mouth の 3 layer が独立タイマー・独立 morph
   * 選択で並走する。人形っぽさを消す key。
   *
   * VRM に存在しない morph は構築時に pool から filter（Perfect Sync 版 VRM で
   * Hana 名が無い region は空 pool になり no-op 化する）。
   */
  private readonly microChannels: ReadonlyArray<MicroChannel>;
  /** 発話音響から顔全体の生理的な賦活を作る反射層。 */
  private readonly speechMicroexpression = new SpeechMicroexpressionSystem();
  private speechExpressionBaseParams: SpeechMicroexpressionParams = {
    ...DEFAULT_SPEECH_MICROEXPRESSION_PARAMS,
  };
  private readonly hasSpeechBrowExpression: boolean;
  private readonly hasSpeechEyeExpression: boolean;
  /** speech acoustic activation は region 別 grounded intent として仲裁する。 */
  private speechBrowIntent: ExpressionIntentHandle | null = null;
  private speechEyeIntent: ExpressionIntentHandle | null = null;
  /** phrase boundary blink の owner。pulse lifecycle は arbiter が回収する。 */
  private speechBoundaryBlinkIntent: ExpressionIntentHandle | null = null;
  private speechBoundaryBlinkCount = 0;
  /** phrase boundary blink 中に ordinary BlinkSystem を停止する token。 */
  private speechBoundaryBlinkSuppressionToken: number | null = null;
  /** startle safety pulse の scope 連番。ordinary auto blink とは別 owner。 */
  private startleBlinkCount = 0;
  private speechExpressionEnabled = true;
  /** voice_say に付随する発話粒度 mood の envelope。 */
  private readonly speechMood: SpeechMoodChannel;
  private readonly speechStateExpressionLayers = new Map<number, SpeechStateExpressionLayer>();
  private nextSpeechStateExpressionLayerId = 1;
  private readonly cursorAttention: CursorAttentionSystem;
  private readonly animationPlayer: AnimationPlayer;
  private readonly proceduralBones: ProceduralBones;
  private readonly beatScheduler: IdleBeatScheduler;
  private readonly beatTarget: BeatTarget;
  private readonly claimState: ClaimState;
  private readonly devLog?: SubsystemLog;
  /**
   * Motion priority queue。M2 時点では field として保持するのみで、Body.play
   * 経路はまだ旧実装（直接 animationPlayer 呼び出し）を通る。M3 で Body.play
   * を scheduler 経由に書き換え、onActivate / onDeactivate を AnimationPlayer
   * に wire up する。
   *
   * 設計仕様: internal design-record: 2026-04-29-motion-priority-queue-design.md §3
   */
  private readonly motionScheduler: MotionScheduler;

  private stateExprState: EyeState | null = null;

  /** Idle elapsed time for gradual relaxed expression. */
  private idleElapsedTime = 0;
  private relaxedValue = 0;

  /**
   * #83 M3: expression intent arbitration。ambient producer（state base /
   * relaxed / idle squint / idle micro）は intent を arbiter へ submit し、
   * admitted な intent だけが slot bridge 経由で ExpressionManager の keyed
   * slot になる。weight の合成・global budget は引き続き ExpressionManager
   * が唯一の mixer として担う。未移行 producer（speech / persona / MCP /
   * auto blink）は legacy slot 経路のまま。
   */
  private readonly expressionIntents = new ExpressionIntentArbiter();
  private readonly expressionIntentBridge: ExpressionIntentSlotBridge;
  /** bridge sync 用の admitted scratch（毎 frame の allocation を避ける）。 */
  private readonly admittedIntentScratch: AdmittedExpressionIntent[] = [];
  /** state base 表情の intent handle（applyStateExpressions と同期）。 */
  private stateExprIntents: ExpressionIntentHandle[] = [];
  /** relaxed 表情の intent handle（updateRelaxed と同期）。 */
  private relaxedIntent: ExpressionIntentHandle | null = null;
  /**
   * idle squint（#83 M3 で EyelidExpressionController から移管）。squint の
   * eyelid 占有は intent 化済みで、auto blink slot の抑止は arbiter の
   * physiology precedence が担う。BlinkSystem の suppression token は
   * 「slot の抑止」でなく「blink state machine の停止」のために残している：
   * token 無しだと squint 終了 frame に進行途中の blink 値が突然現れる。
   */
  private readonly idleSquint = new IdleSquintSystem();
  private squintIntent: ExpressionIntentHandle | null = null;
  private squintSuppressionToken: number | null = null;
  /** speech mood intent の utterance scope 連番（#83 M4）。 */
  private speechMoodUtteranceCount = 0;
  /** legacy slot API（express / acquireExpressionSlot）の scope 連番（#83 M5）。 */
  private legacySlotScopeCount = 0;
  /** 自律 blink の intent handle（#83 M5 で EyelidExpressionController から移管）。 */
  private autoBlinkIntent: ExpressionIntentHandle | null = null;

  // State-driven animation は現在無効化中（Typing.vrma 差し替え待ち）。
  // 有効化時にコメントを外す。
  // private stateMotionHandle: InternalMotionHandle | null = null;

  /**
   * MotionScheduler が現在 active 化している AnimationPlayer の playback handle。
   * onActivate で set、natural 完了 / onDeactivate で clear する。
   * onDeactivate からこの handle 経由で stop / cancel を呼ぶ。
   *
   * 設計仕様: internal design-record: 2026-04-29-motion-priority-queue-design.md §5.1
   */
  private activeMotionPlayback: {
    readonly stop: (fadeMs?: number) => Promise<void>;
    readonly cancel: () => void;
  } | null = null;
  /** Invalidates AnimationPlayer.play() results that arrive after ownership changed. */
  private motionActivationGeneration = 0;

  /** Track all active expression handles for interrupt(). */
  private readonly activeExprHandles = new Set<BodyExpressionHandle>();
  /** Track all active gaze handles for interrupt(). */
  private readonly activeGazeHandles = new Set<BodyGazeHandle>();
  private cursorAttentionLogTimer = 0;

  /** attention.subscribe の解除トークン。initAttention / disposeAttention で管理。 */
  private attentionSub: Disposable | null = null;

  /** 直前の attention snapshot の source。source 変化検知に使用。 */
  private lastAttentionSource: string | null = null;

  /** LipSync 音声解析ソース。再生中だけ毎フレーム sampleMouth() を pull する。 */
  private lipSyncSource: LipSyncSource | null = null;
  private readonly lipSyncMouthScratch = createMouthValues();
  private readonly cursorAttentionOutput: MutableCursorAttentionOutput = {
    mode: null,
    headYawRad: 0,
    headPitchRad: 0,
    eyeYawDeg: 0,
    eyePitchDeg: 0,
  };
  private readonly eyeOutputScratch: MutableEyeOutput = { yaw: 0, pitch: 0 };

  /** Startle 反射の cooldown 計時。update の delta で進める。 */
  private timeSinceStartle = STARTLE_COOLDOWN_S;

  /** VRM head の screen 座標（three-runtime が毎 frame setHeadClientReference で更新）。 */
  private headClientX = 0;
  private headClientY = 0;
  private viewportWidth = 0;
  private viewportHeight = 0;

  constructor(vrm: VRM, devLog?: SubsystemLog, claimState?: ClaimState) {
    this.vrm = vrm;
    this.devLog = devLog;
    this.claimState = claimState ?? getClaimState();
    this.expressions = new ExpressionManager();
    this.expressionIntentBridge = new ExpressionIntentSlotBridge(
      this.expressions,
      new ExpressionIntentResolver(),
    );
    // #83 M4: speech mood の実体は expression intent（replacementKey で常に
    // 最新 1 つ）。attack / release の envelope 意味論は SpeechMoodChannel が
    // 持ち続け、intent へは envelope 済みの intensity が毎 frame 流れる。
    // acquire / release 直後に sync するのは legacy addSlot の「同 tick で
    // slot が見える」即時性を保つため。
    this.speechMood = new SpeechMoodChannel((preset, intensity) => {
      const handle = this.expressionIntents.acquire({
        owner: {
          producerId: "speech-mood",
          scopeId: `utterance-${++this.speechMoodUtteranceCount}`,
          replacementKey: "speech-mood",
        },
        source: "speech",
        semantic: { role: "grounded-state", state: preset },
        occupancy: FULL_FACE_AFFECT_OCCUPANCY,
        salience: "grounded",
        intensity,
        lifecycle: { kind: "held" },
      });
      this.syncExpressionIntents();
      return {
        setIntensity: (value: number) => {
          handle.updateIntensity(value);
        },
        release: () => {
          handle.release();
          this.syncExpressionIntents();
        },
      };
    });
    this.blinkSystem = new BlinkSystem();
    this.eyeSystem = new EyeSystem();
    // Region 別 micro layer — 各 instance は独立タイマー・独立 morph 選択で並走する。
    // VRM に存在しない morph は region 単位で filter（Perfect Sync 移行や別 VRM で
    // pool が空になっても system は no-op 化するだけで動作は壊れない）。
    const filterPool = (pool: ReadonlyArray<string>): ReadonlyArray<string> =>
      pool.filter((name) => vrm.expressionManager?.getExpression(name) !== null);
    this.hasSpeechBrowExpression =
      vrm.expressionManager?.getExpression(SPEECH_BROW_EXPRESSION_NAME) !== null;
    this.hasSpeechEyeExpression =
      vrm.expressionManager?.getExpression(SPEECH_EYE_EXPRESSION_NAME) !== null;
    this.microChannels = [
      new MicroChannel(
        "brow",
        new IdleMicroexpressionSystem(undefined, filterPool(MICRO_BROW_POOL)),
        this.expressionIntents,
      ),
      new MicroChannel(
        "eye",
        new IdleMicroexpressionSystem(undefined, filterPool(MICRO_EYE_POOL)),
        this.expressionIntents,
      ),
      new MicroChannel(
        "mouth",
        new IdleMicroexpressionSystem(undefined, filterPool(MICRO_MOUTH_POOL)),
        this.expressionIntents,
      ),
    ];
    this.cursorAttention = new CursorAttentionSystem(
      /* random */ undefined,
      /* onEvent */ (event) => {
        this.devLog?.write({
          phase: "gaze",
          note:
            event.kind === "start"
              ? `gaze episode start: ${event.mode}`
              : `gaze episode end: ${event.mode}`,
          data: {
            mode: event.mode,
            durationS: Number(event.durationS.toFixed(2)),
            nextDelayS: event.nextDelayS === null ? null : Number(event.nextDelayS.toFixed(2)),
          },
        });
      },
      /* ambientGate */ () => getAttentionRuntime().get().target !== null,
    );
    this.animationPlayer = new AnimationPlayer(vrm, devLog);
    this.proceduralBones = new ProceduralBones();
    this.proceduralBones.bindVrm(vrm);
    this.beatTarget = this.createBeatTarget();
    this.beatScheduler = new IdleBeatScheduler(defaultProfiles);

    this.motionScheduler = new MotionScheduler({
      onActivate: async (req) => {
        const generation = ++this.motionActivationGeneration;
        // AnimationPlayer.play() を呼んで clip を mixer に載せる。返値の handle
        // (stop / cancel / completion) を activeMotionPlayback に保持し、
        // onDeactivate が同じ playback を停止できるようにする。
        //
        // play() の Promise が natural に resolve（= completion fulfilled）した時点で
        // MotionScheduler 側は「自然完了」として扱う。preempt / cancel の場合は
        // onDeactivate が先に handle.stop / cancel を呼び、completion を resolve させる
        // ことで本 await が抜ける（MotionScheduler の settled guard が二重 resolve を防ぐ）。
        const result = await this.animationPlayer.play(req.animation, {
          fadeInMs: req.options?.fadeInMs,
          fadeOutMs: req.options?.fadeOutMs,
          weight: req.options?.weight,
          loop: req.options?.loop,
          speed: req.options?.speed,
        });
        if (generation !== this.motionActivationGeneration) {
          result.cancel();
          return;
        }
        this.activeMotionPlayback = { stop: result.stop, cancel: result.cancel };
        try {
          await result.completion;
        } finally {
          if (this.activeMotionPlayback?.stop === result.stop) {
            this.activeMotionPlayback = null;
          }
        }
      },
      onDeactivate: (fadeMs) => {
        this.motionActivationGeneration++;
        // active な playback があれば停止。fadeMs が 0 なら cancel（即時）、
        // それ以外は stop(fadeMs)。stop は async だが onDeactivate は void 契約
        // なので fire-and-forget でよい（completion 解決は MotionScheduler 側で
        // resolveCompletion により先行している）。
        const playback = this.activeMotionPlayback;
        if (!playback) return;
        this.activeMotionPlayback = null;
        if (fadeMs <= 0) {
          playback.cancel();
        } else {
          void playback.stop(fadeMs);
        }
      },
      now: () => performance.now(),
    });

    this.applyStateExpressions("idle");
  }

  /**
   * Per-frame update. Call from the render loop.
   * Drives all subsystems and applies to VRM.
   */
  /**
   * Set the activity state. Affects eye patterns, head drift, and expressions.
   * Called by Perception (via tool-activity events) or handler logic.
   */
  setLipSyncSource(source: LipSyncSource | null): void {
    this.lipSyncSource = source;
  }

  /** 発話反射層の master enable を切り替える。 */
  setSpeechExpressionEnabled(enabled: boolean): void {
    this.speechExpressionEnabled = enabled;
  }

  /** 発話反射層の感触パラメータを部分更新する。 */
  setSpeechExpressionParams(params: Partial<SpeechMicroexpressionParams>): void {
    this.speechExpressionBaseParams = { ...this.speechExpressionBaseParams, ...params };
    this.applySpeechExpressionParams();
  }

  /** Restores the low-salience acoustic variation profile used without a grounded state. */
  resetSpeechExpressionParams(): void {
    this.speechExpressionBaseParams = { ...DEFAULT_SPEECH_MICROEXPRESSION_PARAMS };
    this.applySpeechExpressionParams();
  }

  /** Starts a speech-owned mood with an attack envelope. */
  setSpeechMood(preset: string, intensity: number): void {
    this.speechMood.setSpeechMood(preset, intensity);
  }

  /** Begins releasing the speech-owned mood. */
  releaseSpeechMood(): void {
    this.speechMood.releaseSpeechMood();
  }

  /** Acquires a layered speech state that restores the previous owner when released. */
  acquireSpeechStateExpression(request: SpeechStateExpressionRequest): SpeechStateExpressionHandle {
    const layer: SpeechStateExpressionLayer = {
      id: this.nextSpeechStateExpressionLayerId++,
      ...request,
    };
    this.speechStateExpressionLayers.set(layer.id, layer);
    this.applySpeechStateExpressionLayers();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        const wasTop = this.topSpeechStateExpressionLayer()?.id === layer.id;
        this.speechStateExpressionLayers.delete(layer.id);
        if (wasTop) this.applySpeechStateExpressionLayers();
      },
    };
  }

  /** idle motion 倍率（0-3, 1 で現状）を breathing / procedural bones に伝播する。 */
  setMotionIntensity(intensity: number): void {
    this.breathing.setIntensity(intensity);
    this.proceduralBones.setIntensity(intensity);
    this.beatScheduler.setIntensity(intensity);
  }

  setState(state: EyeState): void {
    // const prevState = this.eyeSystem.state;
    this.eyeSystem.setState(state);
    this.blinkSystem.setState(state);
    this.proceduralBones.setActivityState(state);
    this.beatScheduler.setState(state, this.buildBeatTarget());
    if (!this.claimState.isClaimed("expression")) {
      this.applyStateExpressions(state);
    }

    // Reset idle relaxed timer when leaving idle
    if (state !== "idle" && !this.claimState.isClaimed("expression")) {
      this.idleElapsedTime = 0;
      this.relaxedValue = 0;
      this.clearRelaxedSlot();
      this.clearIdleSquint();
    }

    // State-driven animation: writing 中のモーション再生。
    // 現在は Typing.vrma の品質問題（procedural との blend 破綻・頻発する tool 呼び出し
    // での視覚ノイズ）により無効化。VRMA 差し替え後にコメントを外す。
    //
    // if (state === "writing" && prevState !== "writing") {
    //   this.stateMotionHandle?.release(400);
    //   this.stateMotionHandle = this.motionScheduler.request({
    //     source: "state",
    //     priority: "state-driven",
    //     animation: "anim:Typing",
    //     options: {
    //       weight: 1,
    //       loop: true,
    //       fadeInMs: 800,
    //     },
    //   });
    // } else if (state !== "writing" && this.stateMotionHandle) {
    //   this.stateMotionHandle.release(400);
    //   this.stateMotionHandle = null;
    // }
  }

  // ─── 生理反射（physiological reflexes）────────────────
  //
  // persona の演技（reaction handler）とは別概念の生理層。瞬き・呼吸と同じ
  // Body built-in で、App.tsx の event → state mutation axis（side-effect only
  // inline trigger）から呼ばれる。persona reaction を経由しないのは
  // docs/decisions/motion-effect-trigger-axes.md の整理に基づく：これは
  // 「どの persona でも起きる生理」であって個性の表現ではない。

  /**
   * Startle 反射：予期しない失敗イベントへの身体反応。
   * 速い瞬き + 頭の微小な引き（chin tuck）+ 一瞬の息止め。
   * エラー連発で痙攣しないよう cooldown 付き。
   */
  notifyStartle(): void {
    if (this.timeSinceStartle < STARTLE_COOLDOWN_S) return;
    this.timeSinceStartle = 0;
    this.expressionIntents.acquire({
      owner: {
        producerId: "startle-blink",
        scopeId: `startle-${++this.startleBlinkCount}`,
        replacementKey: "blink",
      },
      source: "reflex",
      semantic: { role: "safety-reflex", target: BLINK_EXPRESSION_NAME, legacyKind: "eye" },
      occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
      salience: "reflex",
      intensity: 1,
      lifecycle: {
        kind: "pulse",
        durationMs: STARTLE_BLINK_DURATION_MS,
        attackMs: EYELID_REFLEX_ATTACK_MS,
        releaseMs: EYELID_REFLEX_RELEASE_MS,
      },
    });
    this.syncExpressionIntents();
    if (this.claimState.isClaimed("animation")) return;
    this.breathing.hold(STARTLE_BREATH_HOLD_S);
    this.proceduralBones.flinchHead();
  }

  /** 注意の切り替え（user の入力送信など）：瞬き + 視線を作業対象へ向け直す。 */
  notifyAttentionShift(): void {
    this.blinkSystem.requestBlink();
    this.eyeSystem.refocusFront();
  }

  /** ターン完了などの区切りで一息つく（深い呼吸を 1 回）。 */
  notifySettle(): void {
    if (this.claimState.isClaimed("animation")) return;
    this.breathing.triggerDeepBreath();
  }

  private buildBeatTarget(): BeatTarget {
    return this.beatTarget;
  }

  private createBeatTarget(): BeatTarget {
    return {
      glance: (yawRad, pitchRad, durationS) => {
        // EyeSystem が override + pendingSaccade を発行し、自動 release も行う(eye-lead)。
        this.eyeSystem.triggerGlance(
          yawRad * (180 / Math.PI),
          pitchRad * (180 / Math.PI),
          durationS,
        );
      },
      addSpineEnvelope: (z, x, durationS) => this.proceduralBones.addSpineEnvelope(z, x, durationS),
      addPostureEnvelope: (leanZ, durationS) =>
        this.proceduralBones.addPostureEnvelope(leanZ, durationS),
      triggerDeepBreath: () => this.breathing.triggerDeepBreath(),
      requestBlink: () => this.blinkSystem.requestBlink(),
      injectMicroExpression: (region, weight, durationS) => {
        const channel = this.microChannels.find((ch) => ch.region === region);
        if (channel && channel.system.pool.length > 0) {
          const pool = channel.system.pool;
          const morph = pool[Math.floor(Math.random() * pool.length)];
          if (morph) channel.system.injectEpisode(morph, weight, durationS);
        }
      },
    };
  }

  update(delta: number, elapsed: number): void {
    const animationClaimed = this.claimState.isClaimed("animation");
    const expressionClaimed = this.claimState.isClaimed("expression");
    this.timeSinceStartle += delta;
    // #83: expression claim は arbiter の context input（domain-claimed reason）
    this.expressionIntents.setDomainClaimed(expressionClaimed);
    this.expressionIntents.update(delta);
    this.updateSpeechBoundaryBlinkSuppression();
    this.speechMood.update(delta);
    // speech mood envelope の intensity 変化を、後段の gate 判定
    // （hasActiveNonIdleMood 等）が同 frame で見えるよう即時反映する。
    // legacy の SpeechMoodChannel → setWeight 直結と同じ時間解像度を保つ。
    this.syncExpressionIntents();
    this.cursorAttention.update(delta);
    const cursorAttention = this.cursorAttention.writeOutput(this.cursorAttentionOutput);
    this.proceduralBones.setHeadLookAtOffset(
      cursorAttention.headYawRad,
      cursorAttention.headPitchRad,
    );
    this.eyeSystem.setAmbientOffset(cursorAttention.eyeYawDeg, cursorAttention.eyePitchDeg);
    this.logCursorAttentionSample(delta, cursorAttention);

    // 1. Animation mixer
    if (!animationClaimed) {
      this.animationPlayer.update(delta);
    }

    // 2. Breathing + procedural bone animation (spine sway, head drift, arm sway)
    //    呼吸は ProceduralBones の bone 書き込みより先に値を確定し、胸郭・肩
    //    オフセットとして渡す（spine sway / arm sway と同 bone への加算合成）。
    //    Complementary weight with VRMA: procedural fades as clips take over,
    //    so procedural's direct rotation assignment doesn't fight clip motion.
    //    (Ported from old Yorishiro AnimationSourceManager.update.)
    const vrmaWeight = this.animationPlayer.getTotalEffectiveWeight();
    const proceduralWeight = Math.max(0, 1 - vrmaWeight);
    this.breathing.setMode(
      this.eyeSystem.state !== "idle" ? "focused" : this.relaxedValue > 0 ? "relaxed" : "idle",
    );
    const breath = this.breathing.update(delta);
    // 2b. Beat scheduler(proceduralBones の前。beat の envelope を先に反映)
    this.beatScheduler.update(delta, this.beatTarget, animationClaimed, expressionClaimed);
    if (!animationClaimed) {
      this.vrm.scene.position.y = breath.offsetY;
      this.proceduralBones.setBreathingOffsets(breath.chestPitch, breath.shoulderLift);
      this.proceduralBones.update(delta, elapsed, proceduralWeight);
    } else {
      this.proceduralBones.clearTransientReflexes();
    }

    // 3. Blink
    const blinkValue = this.blinkSystem.update(delta);
    if (!expressionClaimed) {
      if (this.eyeSystem.state !== "idle" && this.relaxedIntent !== null) {
        this.idleElapsedTime = 0;
        this.clearRelaxedSlot();
      }
      if (this.stateExprState !== this.eyeSystem.state) {
        this.applyStateExpressions(this.eyeSystem.state);
      }
    }

    // 4. Eye system (state-dependent patterns)
    this.eyeSystem.update(delta);

    // 4b. Eye-head coordination + gaze-evoked blink。
    //     大きい saccade では頭が遅れて同方向に追従し（目が先・頭が後）、
    //     確率的に瞬きを伴う。blink 抽選は EyeSystem 側で確定済み。
    const saccade = this.eyeSystem.consumeSaccadeEvent();
    if (saccade) {
      if (saccade.blinkWorthy && !expressionClaimed) this.blinkSystem.requestBlink();
      const focusState = this.eyeSystem.state === "reading" || this.eyeSystem.state === "writing";
      const headMin =
        saccade.origin === "glance" && !focusState
          ? GLANCE_HEAD_RECRUITMENT_MIN
          : HEAD_RECRUITMENT_MIN_MAGNITUDE;
      if (!animationClaimed && !focusState && saccade.magnitude >= headMin) {
        this.proceduralBones.nudgeHeadToward(
          saccade.targetYawDeg * (Math.PI / 180) * HEAD_RECRUITMENT_GAIN,
        );
      }
    }

    // 5 で 5b と 6 の両方で lip sync 値が要るので、ここで 1 度だけ pull してキャッシュ。
    // LipSyncAnalyser.sample() の smoothing が二重に進まないようにする目的もある。
    const lipSyncSource = this.lipSyncSource;
    const lipSyncMouth =
      lipSyncSource && (lipSyncSource.isMouthActive?.() ?? true)
        ? lipSyncSource.sampleMouth(this.lipSyncMouthScratch)
        : null;
    const speechReflex = this.speechMicroexpression.update(
      delta,
      lipSyncMouth,
      !expressionClaimed && this.speechExpressionEnabled,
    );
    if (!expressionClaimed) this.updateSpeechMicroexpressionIntents(speechReflex);

    // 5. Gradual relaxed expression (idle 30s+ → relaxed face)
    if (!expressionClaimed) {
      // producer は自身の生成条件（idle state）だけを見る。persona / speech 等との
      // overlap は intent を維持したまま Arbiter が suppress / revive する。
      this.updateRelaxed(delta);
      const idleFace = this.eyeSystem.state === "idle";
      // idle squint episode（eyelid physiology の ambient 占有）。auto blinkとの
      // overlapは両intentを維持したままphysiology precedenceが調停する。
      this.updateIdleSquint(delta, idleFace);
      this.updateAutoBlink(blinkValue);

      // 5b. Region 別 idle micro layer — brow / eye / mouth が独立 instance で並走。
      //     発話中は mouth の viseme に加え、brow / eye も発話反射層へ所有権を渡す。
      for (const ch of this.microChannels) {
        // mouth articulation も別laneなので競合扱いしない。全regionともproducer
        // 固有条件（idle state）のみで進め、overlapはArbiterへ委譲する。
        ch.update(delta, idleFace);
      }
    } else {
      // domain claim中はproducer clockを凍結し、owner/episodeを維持する。
      // Arbiter snapshotはdomain-claimedを示し、claim解除後はtimer再sampleなしで復帰する。
    }

    // 5c. admitted intent を slot bridge で ExpressionManager に同期する。
    //     claim 中も sync は行う（arbiter の admission は claim を無視する）。
    //     claim の実効は step 6 の apply guard が担い、legacy の「claim 中も
    //     slot は据え置き、VRM 書き込みだけ止まる」挙動と互換を保つ。
    this.syncExpressionIntents();

    // 6. Apply expressions to VRM
    if (!expressionClaimed) {
      this.applyExpressions(lipSyncMouth);
    }

    // 7. Apply eye gaze to VRM
    this.applyGaze();

    // 8. VRM spring bones etc.
    this.vrm.update(delta);
  }

  /**
   * Return a CharacterAPI bound to this Body instance.
   * This is what PersonaContext.character exposes.
   */
  createCharacterAPI(): CharacterAPI {
    return {
      play: (animation: AnimationRef, options?: PlayOptions) => this.play(animation, options),
      express: (target: ExpressionTarget, intensity: number) => this.express(target, intensity),
      gaze: (target: GazeTarget, options?: GazeOptions) => this.gaze(target, options),
      interrupt: (reason?: string) => this.interrupt(reason),
    };
  }

  /** Dispose all resources. */
  dispose(): void {
    this.disposeAttention();
    this.motionScheduler.cancelAll(0);
    this.motionActivationGeneration++;
    this.animationPlayer.stopAll();
    for (const handle of [...this.activeExprHandles]) handle.releaseInternal();
    for (const handle of [...this.activeGazeHandles]) handle.releaseInternal();
    this.speechMood.dispose();
    this.speechStateExpressionLayers.clear();
    for (const handle of this.stateExprIntents) handle.release();
    this.stateExprIntents = [];
    this.clearRelaxedSlot();
    this.clearIdleSquint();
    this.autoBlinkIntent?.release();
    this.autoBlinkIntent = null;
    this.speechBrowIntent?.release();
    this.speechBrowIntent = null;
    this.speechEyeIntent?.release();
    this.speechEyeIntent = null;
    this.speechBoundaryBlinkIntent?.release();
    this.speechBoundaryBlinkIntent = null;
    this.clearSpeechBoundaryBlinkSuppression();
    for (const channel of this.microChannels) channel.clear();
    this.expressionIntents.clear();
    this.expressionIntentBridge.clear();

    // 前frameにsinkへ書いたcustom morphを含め、dispose時に必ず0へ戻す。
    const exprMgr = this.vrm.expressionManager;
    if (exprMgr) {
      this.expressionBatch.clear();
      this.expressionSink.apply(this.expressionBatch, (name, weight) => {
        exprMgr.setValue(name, weight);
      });
    }
  }

  /**
   * VRM head の screen 座標と viewport サイズを毎 frame 更新する。
   * three-runtime の render loop から呼ばれる。attention subscriber が
   * setPointerPositionFromHead を呼ぶ際の基準点として使用する。
   */
  setHeadClientReference(
    headClientX: number,
    headClientY: number,
    width: number,
    height: number,
  ): void {
    this.headClientX = headClientX;
    this.headClientY = headClientY;
    this.viewportWidth = width;
    this.viewportHeight = height;
  }

  /**
   * attention runtime の subscribe を開始する。
   * snapshot.target が存在する場合、その rect 中心を CursorAttentionSystem に
   * 供給することで Body の視線が「現在の attention target」を追う。
   *
   * source が null → 非 null、または別の source に変化した時点で
   * triggerCursorAttention を呼び CursorAttentionSystem の即時 episode を起動する。
   * 同一 source の rect 更新（pointermove 等）では再 trigger しない（二重起動回避）。
   *
   * idempotent（2 回呼んでも 2 本張らない）。
   */
  initAttention(): void {
    if (this.attentionSub !== null) return;
    const attention = getAttentionRuntime();
    this.attentionSub = attention.subscribe((snapshot: AttentionSnapshot) => {
      if (snapshot.target === null) {
        this.lastAttentionSource = null;
        return;
      }
      const cx = snapshot.target.rect.x + snapshot.target.rect.width / 2;
      const cy = snapshot.target.rect.y + snapshot.target.rect.height / 2;

      // source 変化を検知して即時 episode を起動（rect のみの更新では trigger しない）
      const newSource = snapshot.target.source;
      if (newSource !== this.lastAttentionSource) {
        // duration は v1 同様 random 1〜3 秒（injectable random は CursorAttentionSystem が保持）
        this.cursorAttention.triggerCursorAttention();
      }
      this.lastAttentionSource = newSource;

      this.cursorAttention.setPointerPositionFromHead(
        cx,
        cy,
        this.headClientX,
        this.headClientY,
        this.viewportWidth,
        this.viewportHeight,
      );
    });
  }

  /** attention subscription を解除する。dispose() 内からも呼ばれる。 */
  disposeAttention(): void {
    if (this.attentionSub !== null) {
      this.attentionSub.dispose();
      this.attentionSub = null;
    }
    this.lastAttentionSource = null;
  }

  // ─── CharacterAPI implementations ─────────────────────

  /**
   * Persona pack ({@link CharacterAPI.play}) からの motion 起動 entrypoint。
   * MotionScheduler 経由で priority queue に乗せ、返値は SDK の AnimationHandle 型に
   * adapt する。priority 値は固定で "persona-handler" を使う（spec §3 / §5.1）。
   *
   * 設計仕様: internal design-record: 2026-04-29-motion-priority-queue-design.md §5.1
   */
  private play(animation: AnimationRef, options?: PlayOptions): AnimationHandle {
    const motionHandle = this.motionScheduler.request({
      source: "persona",
      priority: "persona-handler",
      animation,
      options: {
        fadeInMs: options?.fadeInMs,
        fadeOutMs: options?.fadeOutMs,
        weight: options?.weight,
        loop: options?.loop,
        speed: options?.speed,
      },
    });
    return adaptMotionHandleToAnimationHandle(motionHandle);
  }

  private express(target: ExpressionTarget, intensity: number): ExpressionHandle {
    const expressionName = expressionTargetToName(target);
    // kind:"part" は region 別の `part-${region}` 内部 kind に展開する。
    // 他の kind は public と internal で一致するので透過。
    const internalKind = expressionTargetToKind(target);
    return this.acquireExpressionIntentSlot(
      "persona",
      internalKind,
      expressionName,
      intensity,
      target,
    );
  }

  /**
   * 外部 source（MCP 等）が expression slot を直接 acquire するための public API。
   * source と kind を必ず渡す。同じ (source, kind) は dedup され、前 slot は
   * 自動的に release される。返り値の handle は ExpressionHandle 互換で、
   * release / setIntensity / effectiveWeight を持つ。
   *
   * #83 M5: 実体は direct-target compatibility intent（legacyKind 付き）で、
   * dedup は replacementKey、抑止は arbiter + manager compatibility priority
   * が担う。public shape / 挙動は legacy addSlot 直結時代と互換。
   *
   * Note: target shape は kind = "mood" の場合 preset 名を、それ以外は
   * 適切な field に expressionName を入れた discriminated union を組む。
   * Phase β では mood のみ MCP 公開なので主に "mood" パスを通る。
   */
  acquireExpressionSlot(
    source: ExpressionSource,
    kind: ExpressionKind,
    expressionName: string,
    intensity: number,
  ): ExpressionHandle {
    const target = buildExpressionTarget(kind, expressionName);
    return this.acquireExpressionIntentSlot(source, kind, expressionName, intensity, target);
  }

  /** express / acquireExpressionSlot 共通の compatibility intent 実装。 */
  private acquireExpressionIntentSlot(
    source: ExpressionSource,
    kind: ExpressionKind,
    expressionName: string,
    intensity: number,
    target: ExpressionTarget,
  ): ExpressionHandle {
    const intent = this.expressionIntents.acquire({
      owner: {
        producerId: `legacy-${source}`,
        scopeId: `slot-${++this.legacySlotScopeCount}`,
        // legacy addSlot の (source, kind) 後勝ち dedup を replacementKey で
        // 再現する（custom のみ name 込みの 3-tuple）
        replacementKey: kind === "custom" ? `${kind}:${expressionName}` : kind,
      },
      source,
      semantic: {
        role: legacySlotRole(source),
        target: expressionName,
        legacyKind: kind,
      },
      occupancy: legacySlotOccupancy(kind, expressionName),
      salience: legacySlotSalience(source),
      intensity,
      lifecycle: { kind: "held" },
    });
    this.syncExpressionIntents();

    // ordinary auto-blink の state machine を explicit blink の間 pause/resetする。
    // Arbiter の precedence だけで出力を隠すと、裏で進んだ途中値が release 直後に
    // 現れるため、source を問わず direct blink owner ごとに token を保持する。
    // startle はこの経路を通らない独立 safety-reflex pulse なので影響を受けない。
    const blinkSuppressionToken =
      expressionName === BLINK_EXPRESSION_NAME ? this.blinkSystem.suppress() : null;

    const handle = new BodyExpressionHandle(
      target,
      expressionName,
      intensity,
      intent,
      this.expressionIntentBridge,
      this.blinkSystem,
      blinkSuppressionToken,
      this.activeExprHandles,
      () => this.syncExpressionIntents(),
    );
    this.activeExprHandles.add(handle);
    return handle;
  }

  /**
   * 現在 active な全 expression slot の snapshot を返す。state.get などの
   * observability で住人 AI が自分の感情構成を読むために使う。
   */
  getExpressionSlots(): ReadonlyArray<SlotSnapshot> {
    return this.expressions.getSlots();
  }

  /**
   * 表情 intent arbitration の reason 付き snapshot（#83 M6）。
   * どの intent が admitted / suppressed で、なぜその結果になったかを返す。
   */
  getExpressionIntentSnapshot(): ExpressionArbitrationSnapshot {
    return this.expressionIntents.getSnapshot();
  }

  /**
   * arbiter snapshot と manager slot snapshot を intentId で join した
   * debug view（#83 M6）。budget-scaled / manager-suppressed /
   * unmapped-target まで説明できる。要求時のみ allocate する。
   */
  getExpressionIntentDebugView(): ExpressionIntentDebugView {
    return buildExpressionIntentDebugView(
      this.expressionIntents.getSnapshot(),
      this.expressions.getSlots(),
      this.expressionIntentBridge.getUnmappedIntentIds(),
    );
  }

  /**
   * 外部 source（MCP 等）が motion slot を acquire するための public API。
   * priority queue に基づく single-active + preempt model で動く。
   *
   * 設計仕様: internal design-record: 2026-04-29-motion-priority-queue-design.md §3
   *
   * Note: M2 時点では Body 内部から本 method を呼ぶ経路は無い（Body.play は
   * 旧経路のまま）。M3 で Body.play を本 scheduler 経由に書き換える。
   */
  acquireMotionSlot(request: SdkMotionRequest): SdkMotionHandle {
    // SDK / internal の MotionRequest は構造的に同型（MotionSource / MotionPriority /
    // MotionOptions も同じ string-literal union と field shape）。internal scheduler
    // の MotionRequest.animation は string、SDK 側は AnimationRef = string なので
    // assignable。境界で cast する。
    return this.motionScheduler.request(request as InternalMotionRequest) as SdkMotionHandle;
  }

  /**
   * 現在 active な motion の snapshot。state.get 等の observability で
   * 住人 AI が自分の motion 構成を読むために使う。
   */
  getMotionSnapshot(): SdkMotionSnapshot {
    return this.motionScheduler.getSnapshot() as SdkMotionSnapshot;
  }

  private topSpeechStateExpressionLayer(): SpeechStateExpressionLayer | null {
    let top: SpeechStateExpressionLayer | null = null;
    for (const layer of this.speechStateExpressionLayers.values()) {
      if (!top || layer.id > top.id) top = layer;
    }
    return top;
  }

  private applySpeechStateExpressionLayers(): void {
    const layer = this.topSpeechStateExpressionLayer();
    this.applySpeechExpressionParams();
    if (layer?.preset && layer.preset !== "neutral") {
      this.setSpeechMood(layer.preset, layer.intensity ?? 0.3);
    } else {
      this.releaseSpeechMood();
    }
  }

  private applySpeechExpressionParams(): void {
    const layer = this.topSpeechStateExpressionLayer();
    this.speechMicroexpression.setParams(this.speechExpressionBaseParams);
    if (layer?.microexpressionParams) {
      this.speechMicroexpression.setParams(layer.microexpressionParams);
    }
  }

  private gaze(target: GazeTarget, _options?: GazeOptions): GazeHandle {
    const angles = gazeTargetToAngles(target);
    const overrideId = this.eyeSystem.setOverride(angles.yaw, angles.pitch);

    const handle = new BodyGazeHandle(target, overrideId, this.eyeSystem, this.activeGazeHandles);
    this.activeGazeHandles.add(handle);
    return handle;
  }

  private interrupt(_reason?: string): void {
    // motion は MotionScheduler 経由で停止する。scheduler が active を 200ms fade で
    // 解放し、onDeactivate callback が AnimationPlayer.stop / cancel を駆動する。
    // 結果として外部挙動（fade-out 200ms）は不変だが、cancellation は
    // getMotionSnapshot() で観察可能になり、completion は {reason: "cancelled"}
    // で resolve される。
    this.motionScheduler.cancelAll(200);

    // Release all expressions
    for (const h of this.activeExprHandles) {
      h.releaseInternal();
    }
    this.activeExprHandles.clear();

    // Release all gazes
    for (const h of this.activeGazeHandles) {
      h.releaseInternal();
    }
    this.activeGazeHandles.clear();
  }

  // ─── Internal apply methods ───────────────────────────

  /**
   * manager resolved output を VRM sink へ流す orchestration（#83 M6 で
   * semantic policy を持たない形に縮小済み）。表情の admission / suppression
   * は arbiter、weight 合成 / budget は ExpressionManager が担い、ここは
   * batch 構築と sink 書き込み、および articulation compatibility seam の
   * 合流だけを行う。
   */
  private applyExpressions(lipSyncMouth: MouthValues | null): void {
    const exprMgr = this.vrm.expressionManager;
    if (!exprMgr) return;

    // 今 frame に書く名前と値を batch にまとめる。
    // ExpressionSinkTracker が前 frame との差分を取って drop された名前を 0 へ戻す。
    const batch = this.expressionBatch;
    this.expressions.writeResolved(batch);

    this.mergeArticulationSeam(batch, lipSyncMouth);

    this.expressionSink.apply(batch, (name, weight) => {
      exprMgr.setValue(name, weight);
    });
  }

  /**
   * Articulation compatibility seam（#83 M6 で命名隔離）。
   *
   * - lip-sync viseme: 高頻度の speech articulation signal で、意味上の
   *   emotion intent ではない。slot 由来の同名 viseme を上書きする（音声
   *   解析値が優先）。audio / viseme lifecycle を articulation coordinator へ
   *   移す作業は #83 の範囲外（decision doc「#83 では行わない」）。
   * expression arbiter はこの seam を suppress しない（mouth/articulation
   * lane の予約。decision doc §3）。speech brow / eye activation は region別
   * grounded intentへ移行済みで、このpost-mix seamには残さない。
   */
  private mergeArticulationSeam(
    batch: Map<string, number>,
    lipSyncMouth: MouthValues | null,
  ): void {
    if (lipSyncMouth && hasMouthSignal(lipSyncMouth)) {
      for (const k of MOUTH_KEYS) {
        batch.set(k, lipSyncMouth[k]);
      }
    }
  }

  /** speech acoustic outputをregion別intentへ同期する。visemeはarticulation seamのまま。 */
  private updateSpeechMicroexpressionIntents(output: SpeechMicroexpressionOutput): void {
    this.speechBrowIntent = this.updateSpeechRegionIntent(
      this.speechBrowIntent,
      this.hasSpeechBrowExpression ? output.browWeight : 0,
      "speech-brow",
      SPEECH_BROW_EXPRESSION_NAME,
      BROW_AFFECT_OCCUPANCY,
    );
    this.speechEyeIntent = this.updateSpeechRegionIntent(
      this.speechEyeIntent,
      this.hasSpeechEyeExpression ? output.eyeWeight : 0,
      "speech-eye",
      SPEECH_EYE_EXPRESSION_NAME,
      EYE_AFFECT_OCCUPANCY,
    );

    if (output.blinkRequested) {
      this.beginSpeechBoundaryBlinkSuppression();
      this.speechBoundaryBlinkIntent = this.expressionIntents.acquire({
        owner: {
          producerId: "speech-boundary-blink",
          scopeId: `boundary-${++this.speechBoundaryBlinkCount}`,
          replacementKey: "blink",
        },
        source: "speech",
        semantic: { role: "explicit-action", target: BLINK_EXPRESSION_NAME, legacyKind: "eye" },
        occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
        salience: "grounded",
        intensity: 1,
        lifecycle: {
          kind: "pulse",
          durationMs: SPEECH_BOUNDARY_BLINK_DURATION_MS,
          attackMs: EYELID_REFLEX_ATTACK_MS,
          releaseMs: EYELID_REFLEX_RELEASE_MS,
        },
      });
    }
  }

  /** speech-boundary pulse の可視期間だけ ordinary auto blink をpause/resetする。 */
  private beginSpeechBoundaryBlinkSuppression(): void {
    if (this.speechBoundaryBlinkSuppressionToken === null) {
      this.speechBoundaryBlinkSuppressionToken = this.blinkSystem.suppress();
    }
  }

  private updateSpeechBoundaryBlinkSuppression(): void {
    if (this.speechBoundaryBlinkSuppressionToken === null) return;
    const boundaryId = this.speechBoundaryBlinkIntent?.intentId;
    const boundary = boundaryId
      ? this.expressionIntents
          .getSnapshot()
          .intents.find((intent) => intent.intentId === boundaryId)
      : undefined;
    // Pulse のrelease envelopeが完全に終わるまでstate machineを止める。
    // 固定timerにすると大きなframe deltaでrelease開始とordinary再開が同frameに
    // 重なるため、Arbiter lifecycleをSOTとして追う。
    if (!boundary || boundary.phase === "expired") {
      this.clearSpeechBoundaryBlinkSuppression();
    }
  }

  private clearSpeechBoundaryBlinkSuppression(): void {
    if (this.speechBoundaryBlinkSuppressionToken !== null) {
      this.blinkSystem.resume(this.speechBoundaryBlinkSuppressionToken);
      this.speechBoundaryBlinkSuppressionToken = null;
    }
  }

  private updateSpeechRegionIntent(
    current: ExpressionIntentHandle | null,
    weight: number,
    producerId: string,
    target: string,
    occupancy: ReadonlyArray<ExpressionOccupancy>,
  ): ExpressionIntentHandle | null {
    if (weight <= 0) {
      current?.release();
      return null;
    }
    if (current !== null) {
      current.updateIntensity(weight);
      return current;
    }
    return this.expressionIntents.acquire({
      owner: { producerId, scopeId: "acoustic", replacementKey: "activation" },
      source: "speech",
      semantic: { role: "grounded-state", target },
      occupancy,
      salience: "grounded",
      intensity: weight,
      lifecycle: { kind: "held" },
    });
  }

  private applyGaze(): void {
    if (!this.vrm.lookAt) return;
    const output = this.eyeSystem.writeOutput(this.eyeOutputScratch);
    this.vrm.lookAt.yaw = output.yaw;
    this.vrm.lookAt.pitch = output.pitch;
    this.vrm.lookAt.applier.applyYawPitch(output.yaw, output.pitch);
  }

  private logCursorAttentionSample(
    delta: number,
    output: {
      readonly mode: "eyes" | "both" | null;
      readonly headYawRad: number;
      readonly headPitchRad: number;
      readonly eyeYawDeg: number;
      readonly eyePitchDeg: number;
    },
  ): void {
    if (!this.cursorAttention.isActive) {
      this.cursorAttentionLogTimer = 0;
      return;
    }
    this.cursorAttentionLogTimer -= delta;
    if (this.cursorAttentionLogTimer > 0) return;
    this.cursorAttentionLogTimer = 0.5;

    const snapshot = this.cursorAttention.getDebugSnapshot();
    this.devLog?.write({
      phase: "gaze",
      note: "gaze sample",
      data: {
        mode: output.mode,
        targetX: Number(snapshot.targetX.toFixed(2)),
        targetY: Number(snapshot.targetY.toFixed(2)),
        lagX: Number(snapshot.lagX.toFixed(2)),
        lagY: Number(snapshot.lagY.toFixed(2)),
        strength: Number(snapshot.strength.toFixed(2)),
        headYawDeg: Number(((output.headYawRad * 180) / Math.PI).toFixed(1)),
        headPitchDeg: Number(((output.headPitchRad * 180) / Math.PI).toFixed(1)),
        eyeYawDeg: Number(output.eyeYawDeg.toFixed(1)),
        eyePitchDeg: Number(output.eyePitchDeg.toFixed(1)),
        remainingS: Number(snapshot.remainingS.toFixed(2)),
      },
    });
  }

  /** Apply state-dependent base expression (neutral/happy/etc.). */
  private applyStateExpressions(state: EyeState): void {
    this.stateExprState = state;
    for (const handle of this.stateExprIntents) {
      handle.release();
    }
    this.stateExprIntents = [];

    // Note: state base 表情は "idle" source（ambient baseline）として intent
    // 登録する。MCP の "mcp" / persona の "persona" と独立に共存する。
    const targets = STATE_EXPRESSIONS[state];
    for (const [name, value] of targets) {
      this.stateExprIntents.push(
        this.expressionIntents.acquire({
          owner: { producerId: "state-base", scopeId: `state-${state}` },
          source: "idle",
          semantic: { role: "baseline", target: name },
          occupancy: FULL_FACE_AFFECT_OCCUPANCY,
          salience: "ambient",
          intensity: value,
          lifecycle: { kind: "held" },
        }),
      );
    }
    // slot 反映は acquire と同 tick（legacy addSlot の即時性を保つ）。
    // sync は claim に依存しないので、boot 時に claim が立っていても安全。
    this.syncExpressionIntents();
  }

  /**
   * intent を slot bridge 経由で ExpressionManager に反映する。suppress された
   * intent も weight 0 の slot として残し、legacy の「上位 source に抑止された
   * slot は effective 0 で残る」slot view 互換を保つ（#83 M5）。
   */
  private syncExpressionIntents(): void {
    this.expressionIntentBridge.sync(
      this.expressionIntents.writeSlotContributions(this.admittedIntentScratch),
    );
  }

  /**
   * idle squint episode を進めて intent / suppression token を管理する
   * （#83 M3 で EyelidExpressionController から移管）。返り値は現在の
   * squint 値 [0, 1]。
   */
  private updateIdleSquint(delta: number, enabled: boolean): number {
    const squintValue = this.idleSquint.update(delta, enabled);
    if (squintValue > 0) {
      if (this.squintSuppressionToken === null) {
        this.squintSuppressionToken = this.blinkSystem.suppress();
      }
      if (this.squintIntent === null) {
        this.squintIntent = this.expressionIntents.acquire({
          owner: { producerId: "idle-squint", scopeId: "squint-episode" },
          source: "idle",
          semantic: { role: "baseline", target: "blink" },
          occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
          salience: "ambient",
          intensity: squintValue,
          lifecycle: { kind: "held" },
        });
      } else {
        this.squintIntent.updateIntensity(squintValue);
      }
      return squintValue;
    }
    this.clearIdleSquint();
    return 0;
  }

  /** idle squint の intent / suppression token を撤去する。 */
  private clearIdleSquint(): void {
    if (this.squintIntent !== null) {
      this.squintIntent.release();
      this.squintIntent = null;
    }
    if (this.squintSuppressionToken !== null) {
      this.blinkSystem.resume(this.squintSuppressionToken);
      this.squintSuppressionToken = null;
    }
  }

  /**
   * 自律 blink を intent として管理する（#83 M5 で EyelidExpressionController
   * から移管）。squint / auto blink / explicit blink の調停は
   * physiology precedence（policy table）が行う。
   */
  private updateAutoBlink(value: number): void {
    if (value > 0) {
      if (this.autoBlinkIntent === null) {
        this.autoBlinkIntent = this.expressionIntents.acquire({
          owner: { producerId: "auto-blink", scopeId: "auto" },
          source: "reflex",
          semantic: { role: "baseline", target: BLINK_EXPRESSION_NAME, legacyKind: "eye" },
          occupancy: EYELID_PHYSIOLOGY_OCCUPANCY,
          salience: "reflex",
          intensity: value,
          lifecycle: { kind: "held" },
        });
      } else {
        this.autoBlinkIntent.updateIntensity(value);
      }
    } else if (this.autoBlinkIntent !== null) {
      this.autoBlinkIntent.release();
      this.autoBlinkIntent = null;
    }
  }

  /** Gradual relaxed expression after idle threshold. */
  private updateRelaxed(delta: number): void {
    if (this.eyeSystem.state !== "idle") {
      this.idleElapsedTime = 0;
      this.relaxedValue = 0;
      this.clearRelaxedSlot();
      return;
    }
    this.idleElapsedTime += delta;

    this.relaxedValue = Math.min(
      Math.max((this.idleElapsedTime - RELAXED_THRESHOLD_S) / RELAXED_RAMP_S, 0),
      RELAXED_MAX,
    );

    if (this.relaxedValue > 0) {
      if (this.relaxedIntent === null) {
        // relaxed は state base (neutral) と併存する部分表情なので、full-face
        // ではなく eye/affect のみを占有する intent として登録する（resolver
        // が legacy と同じ idle/custom slot に解決する）。
        this.relaxedIntent = this.expressionIntents.acquire({
          owner: { producerId: "idle-relaxed", scopeId: "relaxed" },
          source: "idle",
          semantic: { role: "baseline", target: "relaxed" },
          occupancy: RELAXED_OCCUPANCY,
          salience: "ambient",
          intensity: this.relaxedValue,
          lifecycle: { kind: "held" },
        });
      } else {
        this.relaxedIntent.updateIntensity(this.relaxedValue);
      }
    } else {
      this.clearRelaxedSlot();
    }
  }

  /** relaxed intent を撤去する（slot は bridge sync が回収する）。 */
  private clearRelaxedSlot(): void {
    if (this.relaxedIntent !== null) {
      this.relaxedIntent.release();
      this.relaxedIntent = null;
    }
  }
}

// ─── Idle micro channel ─────────────────────────────────
//
// Region (brow / eye / mouth) ごとの IdleMicroexpressionSystem と、その出力を
// expression intent として arbiter へ流し込む state を 1 unit に束ねた helper。
// Body は region 別に 3 instance 持って並走させ、人形っぽさを消す。

type MicroRegion = "brow" | "eye" | "mouth";

class MicroChannel {
  private intent: ExpressionIntentHandle | null = null;
  private intentMorph: string | null = null;
  private episodeCount = 0;
  private readonly occupancy: ReadonlyArray<{ region: MicroRegion; lane: "affect" }>;
  private readonly eventScratch: MutableMicroexpressionEvent = { morph: "", weight: 0 };

  constructor(
    readonly region: MicroRegion,
    readonly system: IdleMicroexpressionSystem,
    private readonly intents: ExpressionIntentArbiter,
  ) {
    this.occupancy = [{ region, lane: "affect" }];
  }

  update(delta: number, enabled: boolean): void {
    this.flush(this.system.writeUpdate(delta, enabled, this.eventScratch));
  }

  clear(): void {
    this.intent?.release();
    this.intent = null;
    this.intentMorph = null;
  }

  /**
   * 直前の system.update() の戻り値をそのまま渡す。
   * - event=null なら intent を release
   * - 同 morph なら intensity だけ更新
   * - 異 morph なら新 episode として acquire（replacementKey で旧を replace）
   * intent は baseline / ambient で、resolver が legacy と同じ
   * (source:"idle", kind:"custom") slot に解決する。他 region の micro や
   * relaxed とは region 別 occupancy の blend として並存する。
   */
  flush(event: MicroexpressionEvent | null): void {
    if (event === null || event.weight <= 0) {
      if (this.intent !== null) {
        this.intent.release();
        this.intent = null;
        this.intentMorph = null;
      }
      return;
    }

    if (event.morph !== this.intentMorph) {
      this.intent = this.intents.acquire({
        owner: {
          producerId: `idle-micro-${this.region}`,
          scopeId: `episode-${++this.episodeCount}`,
          replacementKey: "micro",
        },
        source: "idle",
        semantic: { role: "baseline", target: event.morph },
        occupancy: this.occupancy,
        salience: "ambient",
        intensity: event.weight,
        lifecycle: { kind: "held" },
      });
      this.intentMorph = event.morph;
    } else {
      this.intent?.updateIntensity(event.weight);
    }
  }
}

// ─── legacy slot → intent 変換（#83 M5 direct-target 互換）──
//
// 既存 public API（express / acquireExpressionSlot）の (source, kind, name)
// を compatibility intent の semantic / occupancy / salience に写す。kind は
// legacyKind として resolver に素通しされるため、この写像は arbitration の
// conflict 判定にだけ効く。

/** eyelid physiology として扱う eye variant（blink 系）。 */
const BLINK_VARIANT_NAMES: ReadonlySet<string> = new Set([
  "blink",
  "blinkL",
  "blinkR",
  "blinkLeft",
  "blinkRight",
]);

function legacySlotRole(
  source: ExpressionSource,
): "baseline" | "grounded-state" | "explicit-action" {
  switch (source) {
    case "idle":
    case "reflex":
      return "baseline";
    case "thinking":
    case "speech":
      return "grounded-state";
    case "persona":
    case "mcp":
    case "system":
      return "explicit-action";
  }
}

function legacySlotSalience(
  source: ExpressionSource,
): "ambient" | "grounded" | "explicit" | "reflex" {
  switch (source) {
    case "idle":
      return "ambient";
    case "thinking":
    case "speech":
      return "grounded";
    case "persona":
    case "mcp":
    case "system":
      return "explicit";
    case "reflex":
      return "reflex";
  }
}

function legacySlotOccupancy(
  kind: ExpressionKind,
  expressionName: string,
): ReadonlyArray<ExpressionOccupancy> {
  switch (kind) {
    case "mood":
      return FULL_FACE_AFFECT_OCCUPANCY;
    case "eye":
      // blink 系は眼瞼の生理、lookUp 等の視線 morph は eye affect
      return BLINK_VARIANT_NAMES.has(expressionName)
        ? EYELID_PHYSIOLOGY_OCCUPANCY
        : EYE_AFFECT_OCCUPANCY;
    case "lip":
      // viseme slot は articulation（表情はこの lane を抑止しない）
      return MOUTH_ARTICULATION_OCCUPANCY;
    case "part-brow":
      return BROW_AFFECT_OCCUPANCY;
    case "part-eye":
      return EYE_AFFECT_OCCUPANCY;
    case "part-mouth":
      return MOUTH_AFFECT_OCCUPANCY;
    case "custom":
      // Fcl_ prefix は region 解決できる。それ以外の arbitrary morph は推測で
      // 分類せず、conflict 不参加（manager priority のみが調停 = legacy 同等）
      if (expressionName.startsWith("Fcl_BRW_")) return BROW_AFFECT_OCCUPANCY;
      if (expressionName.startsWith("Fcl_EYE_")) return EYE_AFFECT_OCCUPANCY;
      if (expressionName.startsWith("Fcl_MTH_")) return MOUTH_AFFECT_OCCUPANCY;
      return EMPTY_OCCUPANCY;
  }
}

// ─── Handle implementations ─────────────────────────────

class BodyExpressionHandle implements ExpressionHandle {
  readonly target: ExpressionTarget;
  readonly expressionName: string;
  readonly requestedIntensity: number;
  private readonly intent: ExpressionIntentHandle;
  private readonly bridge: ExpressionIntentSlotBridge;
  private readonly blinkSystem: BlinkSystem;
  private readonly blinkSuppressionToken: number | null;
  private readonly registry: Set<BodyExpressionHandle>;
  /** intent の変更を同 tick で slot に反映するための sync callback。 */
  private readonly syncIntents: () => void;
  private released = false;

  constructor(
    target: ExpressionTarget,
    expressionName: string,
    intensity: number,
    intent: ExpressionIntentHandle,
    bridge: ExpressionIntentSlotBridge,
    blinkSystem: BlinkSystem,
    blinkSuppressionToken: number | null,
    registry: Set<BodyExpressionHandle>,
    syncIntents: () => void,
  ) {
    this.target = target;
    this.expressionName = expressionName;
    this.requestedIntensity = intensity;
    this.intent = intent;
    this.bridge = bridge;
    this.blinkSystem = blinkSystem;
    this.blinkSuppressionToken = blinkSuppressionToken;
    this.registry = registry;
    this.syncIntents = syncIntents;
  }

  get effectiveWeight(): number {
    return this.bridge.getEffectiveWeightForIntent(this.intent.intentId);
  }

  setIntensity(intensity: number): void {
    if (this.released) return;
    this.intent.updateIntensity(intensity);
    this.syncIntents();
  }

  release(_fadeMs?: number): void {
    if (this.released) return;
    this.releaseInternal();
  }

  /** Called by Body.interrupt() — no fade, immediate cleanup. */
  releaseInternal(): void {
    if (this.released) return;
    this.released = true;
    this.intent.release();
    this.registry.delete(this);

    if (this.blinkSuppressionToken !== null) {
      this.blinkSystem.resume(this.blinkSuppressionToken);
    }
    this.syncIntents();
  }
}

class BodyGazeHandle implements GazeHandle {
  readonly target: GazeTarget;
  private readonly overrideId: number;
  private readonly eyeSystem: EyeSystem;
  private readonly registry: Set<BodyGazeHandle>;
  private released = false;

  constructor(
    target: GazeTarget,
    overrideId: number,
    eyeSystem: EyeSystem,
    registry: Set<BodyGazeHandle>,
  ) {
    this.target = target;
    this.overrideId = overrideId;
    this.eyeSystem = eyeSystem;
    this.registry = registry;
  }

  get active(): boolean {
    return !this.released;
  }

  release(): void {
    if (this.released) return;
    this.releaseInternal();
  }

  /** Called by Body.interrupt(). */
  releaseInternal(): void {
    if (this.released) return;
    this.released = true;
    this.eyeSystem.releaseOverride(this.overrideId);
    this.registry.delete(this);
  }
}

/**
 * acquireExpressionSlot 内で使用する ExpressionTarget 構築 helper。
 * SDK の ExpressionTarget は kind ごとに異なる field を持つ discriminated
 * union なので、kind と expressionName から最も妥当な target を組む。
 *
 * Phase β では mood のみ MCP 公開だが、将来 eye / lip / custom も外部から
 * acquire される可能性に備えて全 kind を網羅する。target の field 値は
 * SDK の string literal union 制約を満たさないこともあるため、unknown 経由で
 * narrow させる（SDK 型の externals は緩めに扱う）。
 */
function buildExpressionTarget(kind: ExpressionKind, expressionName: string): ExpressionTarget {
  // 内部 kind が `part-${region}` の場合、handle の表面 SDK 形は kind:"custom" に
  // 落とす。expressionName (= "Fcl_BRW_Sorrow" 等) から region/emotion を逆引きする
  // 不可逆 lossy なので、外向き観察用としては raw morph 名を持つ "custom" の方が誠実。
  // SDK 経由で取得した handle.target は acquire 元の意味を完全に保つ必要はない。
  if (kind === "part-brow" || kind === "part-eye" || kind === "part-mouth") {
    return {
      kind: "custom",
      blendShapeName: expressionName,
    };
  }
  switch (kind) {
    case "mood":
      return {
        kind: "mood",
        preset: expressionName,
      } as unknown as ExpressionTarget;
    case "eye":
      return {
        kind: "eye",
        variant: expressionName,
      } as unknown as ExpressionTarget;
    case "lip":
      return {
        kind: "lip",
        phoneme: expressionName,
      } as unknown as ExpressionTarget;
    case "custom":
      return {
        kind: "custom",
        blendShapeName: expressionName,
      };
  }
}

/**
 * Internal MotionHandle (priority queue layer) を SDK の AnimationHandle 形に
 * 変換する bridge。persona pack の既存 callsite (`ctx.character.play(...).stop()` 等)
 * は AnimationHandle 形を期待しているため、shape を保ったまま実体を MotionScheduler
 * に委譲する。
 *
 * 設計仕様: internal design-record: 2026-04-29-motion-priority-queue-design.md §5.1
 *
 * - `setWeight`: priority queue model では active 中の動的 weight 変更は取り扱わず、
 *   no-op + dev console warning に倒す。weight を変えたい場合は新しい play() を発行する
 *   (= 同 priority preempt として last-write-wins に乗る) のが正規路。
 * - `stop(fadeMs)`: MotionHandle.release(fadeMs) に転送。AnimationHandle 契約上は
 *   `Promise<void>` を返す必要があるため、internal completion を `void` に narrow して
 *   返す（reason 区別は外には漏らさない）。
 * - `cancel`: MotionHandle.cancel に直結。
 * - `completion`: `{reason}` 付きの internal completion を `void` に narrow。
 */
function adaptMotionHandleToAnimationHandle(motion: InternalMotionHandle): AnimationHandle {
  const completion: Promise<void> = motion.completion.then(() => undefined);
  return {
    animation: motion.animation,
    startedAt: motion.startedAt,
    setWeight: (_weight: number, _fadeMs?: number) => {
      console.warn(
        "[motion] AnimationHandle.setWeight is no-op under priority-queue model; " +
          "issue a fresh character.play() to change weight",
      );
    },
    stop: (fadeMs?: number) => {
      motion.release(fadeMs);
      return completion;
    },
    cancel: () => {
      motion.cancel();
    },
    completion,
  };
}

export { AnimationPlayer } from "./animation-player";
export { BlinkSystem } from "./blink-system";
// #83: expression intent arbitration の観察用 re-export
export type {
  ExpressionArbitrationSnapshot,
  ExpressionIntentPhase,
  ExpressionIntentReason,
  ExpressionIntentSnapshotEntry,
} from "./expression-intent";
export type {
  ExpressionIntentDebugEntry,
  ExpressionIntentDebugView,
} from "./expression-intent-debug";
// Re-export subsystem types for testing
export {
  type ExpressionKind,
  ExpressionManager,
  type ExpressionSource,
  expressionTargetToName,
  type SlotSnapshot,
} from "./expression-manager";
export { type EyeState, EyeSystem, gazeTargetToAngles } from "./eye-system";
export { IdleSquintSystem } from "./idle-squint-system";
export { ProceduralBones } from "./procedural-bones";
