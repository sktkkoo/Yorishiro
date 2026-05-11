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
 * Philosophy: docs/philosophy/PRESENCE_HARNESS.md "六要素 > 身体"
 * SDK surface: src/sdk/context.d.ts CharacterAPI (262-292)
 */

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
} from "@charminal/sdk";
import type { VRM } from "@pixiv/three-vrm";
import { getAttentionRuntime } from "../../runtime/attention-runtime";
import { type ClaimState, getClaimState } from "../../runtime/ui-claim-state";
import type { SubsystemLog } from "../dev-log";
import type { MouthValues } from "../voice/mouth-values";
import { MOUTH_KEYS } from "../voice/mouth-values";
import { AnimationPlayer } from "./animation-player";
import { BlinkSystem } from "./blink-system";
import { CursorAttentionSystem } from "./cursor-attention";
import {
  type ExpressionKind,
  ExpressionManager,
  ExpressionSinkTracker,
  type ExpressionSource,
  expressionTargetToKind,
  expressionTargetToName,
  type SlotSnapshot,
} from "./expression-manager";
import { type EyeState, EyeSystem, gazeTargetToAngles } from "./eye-system";
import { EyelidExpressionController } from "./eyelid-expression-controller";
import {
  IdleMicroexpressionSystem,
  MICRO_BROW_POOL,
  MICRO_EYE_POOL,
  MICRO_MOUTH_POOL,
  type MicroexpressionEvent,
} from "./idle-microexpression-system";
import {
  type MotionHandle as InternalMotionHandle,
  type MotionRequest as InternalMotionRequest,
  MotionScheduler,
} from "./motion-scheduler";
import { ProceduralBones } from "./procedural-bones";

// ─── Constants ───────────────────────────────────────────

/** Body が lip sync 値を pull するためのインターフェース。 */
export interface LipSyncSource {
  sampleMouth(): MouthValues;
}

const BREATHING_AMPLITUDE = 0.005;
const BREATHING_FREQUENCY = 0.8;
const BLINK_EXPRESSION_NAME = "blink";

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
  private readonly blinkSystem: BlinkSystem;
  private readonly eyeSystem: EyeSystem;
  private readonly eyelids: EyelidExpressionController;
  /**
   * Idle 中の Fcl_* morph 微震えで実在性を立ち上げる反射層。Region 別に独立
   * instance を持つ：brow / eye / mouth の 3 layer が独立タイマー・独立 morph
   * 選択で並走する。人形っぽさを消す key。
   *
   * VRM に存在しない morph は構築時に pool から filter（Perfect Sync 版 VRM で
   * Hana 名が無い region は空 pool になり no-op 化する）。
   */
  private readonly microChannels: ReadonlyArray<MicroChannel>;
  private readonly cursorAttention: CursorAttentionSystem;
  private readonly animationPlayer: AnimationPlayer;
  private readonly proceduralBones: ProceduralBones;
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

  /** State-dependent expression slot IDs. */
  private stateExprSlots: number[] = [];
  private stateExprState: EyeState | null = null;

  /** Idle elapsed time for gradual relaxed expression. */
  private idleElapsedTime = 0;
  private relaxedValue = 0;
  private relaxedSlotId = -1;

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

  /** Track all active expression handles for interrupt(). */
  private readonly activeExprHandles = new Set<BodyExpressionHandle>();
  /** Track all active gaze handles for interrupt(). */
  private readonly activeGazeHandles = new Set<BodyGazeHandle>();
  private cursorAttentionLogTimer = 0;

  /** attention.subscribe の解除トークン。initAttention / disposeAttention で管理。 */
  private attentionSub: Disposable | null = null;

  /** 直前の attention snapshot の source。source 変化検知に使用。 */
  private lastAttentionSource: string | null = null;

  /** LipSync 音声解析ソース。再生中に毎フレーム sampleMouth() を pull する。 */
  private lipSyncSource: LipSyncSource | null = null;

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
    this.blinkSystem = new BlinkSystem();
    this.eyeSystem = new EyeSystem();
    this.eyelids = new EyelidExpressionController(this.expressions, this.blinkSystem);
    // Region 別 micro layer — 各 instance は独立タイマー・独立 morph 選択で並走する。
    // VRM に存在しない morph は region 単位で filter（Perfect Sync 移行や別 VRM で
    // pool が空になっても system は no-op 化するだけで動作は壊れない）。
    const filterPool = (pool: ReadonlyArray<string>): ReadonlyArray<string> =>
      pool.filter((name) => vrm.expressionManager?.getExpression(name) !== null);
    this.microChannels = [
      new MicroChannel(
        "brow",
        new IdleMicroexpressionSystem(undefined, filterPool(MICRO_BROW_POOL)),
        this.expressions,
      ),
      new MicroChannel(
        "eye",
        new IdleMicroexpressionSystem(undefined, filterPool(MICRO_EYE_POOL)),
        this.expressions,
      ),
      new MicroChannel(
        "mouth",
        new IdleMicroexpressionSystem(undefined, filterPool(MICRO_MOUTH_POOL)),
        this.expressions,
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

    this.motionScheduler = new MotionScheduler({
      onActivate: async (req) => {
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

  setState(state: EyeState): void {
    // const prevState = this.eyeSystem.state;
    this.eyeSystem.setState(state);
    // "thinking family": Claude のターン中は writing 以外ずっと頭を揺らす。
    // writing を除外するのは Typing.vrma と procedural head drift がぶつかるため。
    this.proceduralBones.isThinking =
      state === "thinking" || state === "reading" || state === "running";
    if (!this.claimState.isClaimed("expression")) {
      this.applyStateExpressions(state);
    }

    // Reset idle relaxed timer when leaving idle
    if (state !== "idle" && !this.claimState.isClaimed("expression")) {
      this.idleElapsedTime = 0;
      this.relaxedValue = 0;
      if (this.relaxedSlotId !== -1) {
        this.expressions.removeSlot(this.relaxedSlotId);
        this.relaxedSlotId = -1;
      }
      this.eyelids.clearIdleSquint();
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

  update(delta: number, elapsed: number): void {
    const animationClaimed = this.claimState.isClaimed("animation");
    const expressionClaimed = this.claimState.isClaimed("expression");
    this.cursorAttention.update(delta);
    const cursorAttention = this.cursorAttention.getOutput();
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

    // 2. Procedural bone animation (spine sway, head drift, arm sway)
    //    Complementary weight with VRMA: procedural fades as clips take over,
    //    so procedural's direct rotation assignment doesn't fight clip motion.
    //    (Ported from old Charminal AnimationSourceManager.update.)
    const vrmaWeight = this.animationPlayer.getTotalEffectiveWeight();
    const proceduralWeight = Math.max(0, 1 - vrmaWeight);
    if (!animationClaimed) {
      this.proceduralBones.update(delta, elapsed, proceduralWeight);
    }

    // 3. Blink
    const blinkValue = this.blinkSystem.update(delta);
    if (!expressionClaimed) {
      if (this.eyeSystem.state !== "idle" && this.relaxedSlotId !== -1) {
        this.idleElapsedTime = 0;
        this.expressions.removeSlot(this.relaxedSlotId);
        this.relaxedSlotId = -1;
      }
      if (this.stateExprState !== this.eyeSystem.state) {
        this.applyStateExpressions(this.eyeSystem.state);
      }
    }

    // 4. Eye system (state-dependent patterns)
    this.eyeSystem.update(delta);

    // 5 で 5b と 6 の両方で lip sync 値が要るので、ここで 1 度だけ pull してキャッシュ。
    // LipSyncAnalyser.sample() の smoothing が二重に進まないようにする目的もある。
    const lipSyncMouth = this.lipSyncSource ? this.lipSyncSource.sampleMouth() : null;
    const lipSyncHasSignal = lipSyncMouth ? MOUTH_KEYS.some((k) => lipSyncMouth[k] > 0) : false;

    // 5. Gradual relaxed expression (idle 30s+ → relaxed face)
    if (!expressionClaimed) {
      const nonIdleMoodActive = this.expressions.hasActiveNonIdleMood();
      this.updateRelaxed(delta, nonIdleMoodActive);
      this.eyelids.update(blinkValue, delta, {
        idle: this.eyeSystem.state === "idle" && !nonIdleMoodActive,
        explicitBlinkActive: this.hasActiveExplicitBlink(),
        relaxedValue: this.relaxedValue,
        neutralSlotId: this.stateExprSlots[0],
      });

      // 5b. Region 別 idle micro layer — brow / eye / mouth が独立 instance で並走。
      //     mouth だけは lip sync 中は suspend（visemes と競合させない）。
      const microBaseEnabled = !nonIdleMoodActive;
      for (const ch of this.microChannels) {
        const enabled = microBaseEnabled && (ch.region !== "mouth" || !lipSyncHasSignal);
        const event = ch.system.update(delta, enabled);
        ch.flush(event);
      }
    } else {
      this.eyelids.clearIdleSquint();
      // claim 中は全 channel を clear して内部 timer を reset しておく
      for (const ch of this.microChannels) {
        ch.system.update(delta, false);
        ch.flush(null);
      }
    }

    // 6. Apply expressions to VRM
    if (!expressionClaimed) {
      this.applyExpressions(lipSyncMouth);
    }

    // 7. Apply eye gaze to VRM
    this.applyGaze();

    // 8. Breathing
    if (!animationClaimed) {
      this.applyBreathing(elapsed);
    }

    // 9. VRM spring bones etc.
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
    this.animationPlayer.stopAll();
    this.activeExprHandles.clear();
    this.activeGazeHandles.clear();
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
    const slotId = this.expressions.addSlot("persona", internalKind, expressionName, intensity);

    const blinkSuppressionToken =
      expressionName === BLINK_EXPRESSION_NAME ? this.blinkSystem.suppress() : null;

    const handle = new BodyExpressionHandle(
      target,
      expressionName,
      intensity,
      slotId,
      this.expressions,
      this.blinkSystem,
      blinkSuppressionToken,
      this.activeExprHandles,
    );
    this.activeExprHandles.add(handle);
    return handle;
  }

  /**
   * 外部 source（MCP 等）が expression slot を直接 acquire するための public API。
   * source と kind を必ず渡す。同じ (source, kind) は dedup され、前 slot は
   * 自動的に release される。返り値の handle は ExpressionHandle 互換で、
   * release / setIntensity / effectiveWeight を持つ。
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
    const slotId = this.expressions.addSlot(source, kind, expressionName, intensity);

    const blinkSuppressionToken =
      expressionName === BLINK_EXPRESSION_NAME ? this.blinkSystem.suppress() : null;

    const target = buildExpressionTarget(kind, expressionName);
    const handle = new BodyExpressionHandle(
      target,
      expressionName,
      intensity,
      slotId,
      this.expressions,
      this.blinkSystem,
      blinkSuppressionToken,
      this.activeExprHandles,
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

  private applyExpressions(lipSyncMouth: MouthValues | null): void {
    const resolved = this.expressions.getResolved();
    const exprMgr = this.vrm.expressionManager;
    if (!exprMgr) return;

    // 今 frame に書く名前と値を batch にまとめる。LipSync は同名 viseme を
    // 上書きする（音声解析値が slot 由来の lip 値より優先）。
    // ExpressionSinkTracker が前 frame との差分を取って drop された名前を 0 へ戻す。
    const batch = new Map(resolved);

    if (lipSyncMouth) {
      const hasSignal = MOUTH_KEYS.some((k) => lipSyncMouth[k] > 0);
      if (hasSignal) {
        for (const k of MOUTH_KEYS) {
          batch.set(k, lipSyncMouth[k]);
        }
      }
    }

    this.expressionSink.apply(batch, (name, weight) => {
      exprMgr.setValue(name, weight);
    });
  }

  private applyGaze(): void {
    if (!this.vrm.lookAt) return;
    const output = this.eyeSystem.getOutput();
    this.vrm.lookAt.yaw = output.yaw;
    this.vrm.lookAt.pitch = output.pitch;
    this.vrm.lookAt.applier.applyYawPitch(output.yaw, output.pitch);
  }

  private applyBreathing(elapsed: number): void {
    this.vrm.scene.position.y = Math.sin(elapsed * BREATHING_FREQUENCY) * BREATHING_AMPLITUDE;
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
    // Remove old state expression slots
    for (const id of this.stateExprSlots) {
      this.expressions.removeSlot(id);
    }
    this.stateExprSlots = [];
    this.stateExprState = state;

    // Add new state expressions
    // Note: state base 表情は "idle" source / "mood" kind で持つ。
    // MCP の "mcp" / persona の "persona" と独立に共存する。
    const targets = STATE_EXPRESSIONS[state];
    for (const [name, value] of targets) {
      this.stateExprSlots.push(this.expressions.addSlot("idle", "mood", name, value));
    }
  }

  /** Gradual relaxed expression after idle threshold. */
  private updateRelaxed(delta: number, nonIdleMoodActive: boolean): void {
    if (this.eyeSystem.state !== "idle" || nonIdleMoodActive) {
      this.idleElapsedTime = 0;
      this.relaxedValue = 0;
      if (this.relaxedSlotId !== -1) {
        this.expressions.removeSlot(this.relaxedSlotId);
        this.relaxedSlotId = -1;
      }
      return;
    }
    this.idleElapsedTime += delta;

    this.relaxedValue = Math.min(
      Math.max((this.idleElapsedTime - RELAXED_THRESHOLD_S) / RELAXED_RAMP_S, 0),
      RELAXED_MAX,
    );

    if (this.relaxedValue > 0) {
      if (this.relaxedSlotId === -1) {
        // 注意: "idle" source / "mood" kind は applyStateExpressions と同じ
        // (source, kind) なので、addSlot 経由だと state base 表情 (neutral) を
        // 巻き込んで release してしまう。relaxed は別 channel として扱うため、
        // 既存の (source, kind) 衝突を避けて直接低レベル API を回避する目的で
        // ここは "idle" + "custom" として登録する（concurrent な複数 idle 系
        // 表情を併存させる意図）。
        this.relaxedSlotId = this.expressions.addSlot(
          "idle",
          "custom",
          "relaxed",
          this.relaxedValue,
        );
      } else {
        this.expressions.setWeight(this.relaxedSlotId, this.relaxedValue);
      }
    } else if (this.relaxedSlotId !== -1) {
      this.expressions.removeSlot(this.relaxedSlotId);
      this.relaxedSlotId = -1;
    }
  }

  private hasActiveExplicitBlink(): boolean {
    for (const handle of this.activeExprHandles) {
      if (handle.expressionName === BLINK_EXPRESSION_NAME) return true;
    }
    return false;
  }
}

// ─── Idle micro channel ─────────────────────────────────
//
// Region (brow / eye / mouth) ごとの IdleMicroexpressionSystem と、その出力を
// ExpressionManager slot に流し込む state を 1 unit に束ねた helper。
// Body は region 別に 3 instance 持って並走させ、人形っぽさを消す。

type MicroRegion = "brow" | "eye" | "mouth";

class MicroChannel {
  private slotId = -1;
  private slotMorph: string | null = null;

  constructor(
    readonly region: MicroRegion,
    readonly system: IdleMicroexpressionSystem,
    private readonly expressions: ExpressionManager,
  ) {}

  /**
   * 直前の system.update() の戻り値をそのまま渡す。
   * - event=null なら slot を release
   * - 同 morph なら weight だけ更新
   * - 異 morph なら release + 新規 acquire
   * Slot は (source:"idle", kind:"custom") を取り、name 別 dedup により他の
   * idle/custom slot (relaxed や他 region の micro) と並存できる。
   */
  flush(event: MicroexpressionEvent | null): void {
    if (event === null || event.weight <= 0) {
      if (this.slotId !== -1) {
        this.expressions.removeSlot(this.slotId);
        this.slotId = -1;
        this.slotMorph = null;
      }
      return;
    }

    if (event.morph !== this.slotMorph) {
      if (this.slotId !== -1) this.expressions.removeSlot(this.slotId);
      this.slotId = this.expressions.addSlot("idle", "custom", event.morph, event.weight);
      this.slotMorph = event.morph;
    } else {
      this.expressions.setWeight(this.slotId, event.weight);
    }
  }
}

// ─── Handle implementations ─────────────────────────────

class BodyExpressionHandle implements ExpressionHandle {
  readonly target: ExpressionTarget;
  readonly expressionName: string;
  readonly requestedIntensity: number;
  private readonly slotId: number;
  private readonly manager: ExpressionManager;
  private readonly blinkSystem: BlinkSystem;
  private readonly blinkSuppressionToken: number | null;
  private readonly registry: Set<BodyExpressionHandle>;
  private released = false;

  constructor(
    target: ExpressionTarget,
    expressionName: string,
    intensity: number,
    slotId: number,
    manager: ExpressionManager,
    blinkSystem: BlinkSystem,
    blinkSuppressionToken: number | null,
    registry: Set<BodyExpressionHandle>,
  ) {
    this.target = target;
    this.expressionName = expressionName;
    this.requestedIntensity = intensity;
    this.slotId = slotId;
    this.manager = manager;
    this.blinkSystem = blinkSystem;
    this.blinkSuppressionToken = blinkSuppressionToken;
    this.registry = registry;
  }

  get effectiveWeight(): number {
    return this.manager.getEffectiveWeight(this.slotId);
  }

  setIntensity(intensity: number): void {
    if (this.released) return;
    this.manager.setWeight(this.slotId, intensity);
  }

  release(_fadeMs?: number): void {
    if (this.released) return;
    this.releaseInternal();
  }

  /** Called by Body.interrupt() — no fade, immediate cleanup. */
  releaseInternal(): void {
    if (this.released) return;
    this.released = true;
    this.manager.removeSlot(this.slotId);
    this.registry.delete(this);

    if (this.blinkSuppressionToken !== null) {
      this.blinkSystem.resume(this.blinkSuppressionToken);
    }
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
// Re-export subsystem types for testing
export {
  type ExpressionKind,
  ExpressionManager,
  type ExpressionSource,
  expressionTargetToName,
  type SlotSnapshot,
} from "./expression-manager";
export { type EyeState, EyeSystem, gazeTargetToAngles } from "./eye-system";
export { EyelidExpressionController } from "./eyelid-expression-controller";
export { IdleSquintSystem } from "./idle-squint-system";
export { ProceduralBones } from "./procedural-bones";
