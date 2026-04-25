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
} from "@charminal/sdk";
import type { VRM } from "@pixiv/three-vrm";
import { getAttentionRuntime } from "../../runtime/attention-runtime";
import { type ClaimState, getClaimState } from "../../runtime/ui-claim-state";
import type { SubsystemLog } from "../dev-log";
import { AnimationPlayer } from "./animation-player";
import { BlinkSystem } from "./blink-system";
import { CursorAttentionSystem } from "./cursor-attention";
import { ExpressionManager, expressionTargetToName } from "./expression-manager";
import { type EyeState, EyeSystem, gazeTargetToAngles } from "./eye-system";
import { EyelidExpressionController } from "./eyelid-expression-controller";
import { ProceduralBones } from "./procedural-bones";

// ─── Constants ───────────────────────────────────────────

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
  private readonly blinkSystem: BlinkSystem;
  private readonly eyeSystem: EyeSystem;
  private readonly eyelids: EyelidExpressionController;
  private readonly cursorAttention: CursorAttentionSystem;
  private readonly animationPlayer: AnimationPlayer;
  private readonly proceduralBones: ProceduralBones;
  private readonly claimState: ClaimState;
  private readonly devLog?: SubsystemLog;

  /** State-dependent expression slot IDs. */
  private stateExprSlots: number[] = [];
  private stateExprState: EyeState | null = null;

  /** Idle elapsed time for gradual relaxed expression. */
  private idleElapsedTime = 0;
  private relaxedValue = 0;
  private relaxedSlotId = -1;

  /** State-driven animation (e.g., Typing during writing). */
  private stateAnimStop: (() => Promise<void>) | null = null;

  /** Track all active expression handles for interrupt(). */
  private readonly activeExprHandles = new Set<BodyExpressionHandle>();
  /** Track all active gaze handles for interrupt(). */
  private readonly activeGazeHandles = new Set<BodyGazeHandle>();
  private cursorAttentionLogTimer = 0;

  /** attention.subscribe の解除トークン。initAttention / disposeAttention で管理。 */
  private attentionSub: Disposable | null = null;

  /** 直前の attention snapshot の source。source 変化検知に使用。 */
  private lastAttentionSource: string | null = null;

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
    this.cursorAttention = new CursorAttentionSystem(undefined, (event) => {
      this.devLog?.write({
        phase: "cursor-attention",
        note:
          event.kind === "start"
            ? `cursor attention start: ${event.mode}`
            : `cursor attention end: ${event.mode}`,
        data: {
          mode: event.mode,
          durationS: Number(event.durationS.toFixed(2)),
          nextDelayS: event.nextDelayS === null ? null : Number(event.nextDelayS.toFixed(2)),
        },
      });
    });
    this.animationPlayer = new AnimationPlayer(vrm, devLog);
    this.proceduralBones = new ProceduralBones();
    this.proceduralBones.bindVrm(vrm);

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
  setState(state: EyeState): void {
    const prevState = this.eyeSystem.state;
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

    // State-driven animation: Typing during writing
    if (state === "writing" && prevState !== "writing") {
      // Stop previous state animation if any
      this.stateAnimStop?.();
      this.animationPlayer
        .play("anim:Typing", { weight: 0.5, loop: true, fadeInMs: 500 })
        .then((result) => {
          this.stateAnimStop = result.stop;
        })
        .catch(() => {});
    } else if (state !== "writing" && this.stateAnimStop) {
      this.stateAnimStop();
      this.stateAnimStop = null;
    }
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

    // 5. Gradual relaxed expression (idle 30s+ → relaxed face)
    if (!expressionClaimed) {
      this.updateRelaxed(delta);
      this.eyelids.update(blinkValue, delta, {
        idle: this.eyeSystem.state === "idle",
        explicitBlinkActive: this.hasActiveExplicitBlink(),
        relaxedValue: this.relaxedValue,
        neutralSlotId: this.stateExprSlots[0],
      });
    } else {
      this.eyelids.clearIdleSquint();
    }

    // 6. Apply expressions to VRM
    if (!expressionClaimed) {
      this.applyExpressions();
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

  private play(animation: AnimationRef, options?: PlayOptions): AnimationHandle {
    const startedAt = performance.now();

    // Kick off async load+play, but return handle synchronously
    const handle: AnimationHandle = {
      animation,
      startedAt,
      setWeight: () => {},
      stop: () => Promise.resolve(),
      cancel: () => {},
      completion: Promise.resolve(),
    };

    // Replace handle internals once loaded
    this.animationPlayer
      .play(animation, {
        fadeInMs: options?.fadeInMs,
        fadeOutMs: options?.fadeOutMs,
        weight: options?.weight,
        loop: options?.loop,
        speed: options?.speed,
        priority: options?.priority,
      })
      .then((result) => {
        // Patch the handle with real controls
        // Using Object.defineProperty to update readonly-ish fields on the returned object
        (handle as { setWeight: AnimationHandle["setWeight"] }).setWeight = result.setWeight;
        (handle as { stop: AnimationHandle["stop"] }).stop = result.stop;
        (handle as { cancel: AnimationHandle["cancel"] }).cancel = result.cancel;
        (handle as { completion: Promise<void> }).completion = result.completion;
      })
      .catch((err) => {
        console.warn("[Body] animation play failed:", err);
      });

    return handle;
  }

  private express(target: ExpressionTarget, intensity: number): ExpressionHandle {
    const expressionName = expressionTargetToName(target);
    const slotId = this.expressions.addSlot(expressionName, intensity);

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

  private gaze(target: GazeTarget, _options?: GazeOptions): GazeHandle {
    const angles = gazeTargetToAngles(target);
    const overrideId = this.eyeSystem.setOverride(angles.yaw, angles.pitch);

    const handle = new BodyGazeHandle(target, overrideId, this.eyeSystem, this.activeGazeHandles);
    this.activeGazeHandles.add(handle);
    return handle;
  }

  private interrupt(_reason?: string): void {
    // Stop all animations
    this.animationPlayer.stopAll(200);

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

  private applyExpressions(): void {
    const resolved = this.expressions.getResolved();
    const exprMgr = this.vrm.expressionManager;
    if (!exprMgr) return;

    // Reset all expressions to 0 first, then set active ones
    // This ensures released expressions don't linger
    exprMgr.setValue("happy", 0);
    exprMgr.setValue("angry", 0);
    exprMgr.setValue("sad", 0);
    exprMgr.setValue("relaxed", 0);
    exprMgr.setValue("surprised", 0);
    exprMgr.setValue("blink", 0);
    exprMgr.setValue("blinkLeft", 0);
    exprMgr.setValue("blinkRight", 0);
    exprMgr.setValue("lookLeft", 0);
    exprMgr.setValue("lookRight", 0);
    exprMgr.setValue("lookUp", 0);
    exprMgr.setValue("lookDown", 0);
    exprMgr.setValue("aa", 0);
    exprMgr.setValue("ih", 0);
    exprMgr.setValue("ou", 0);
    exprMgr.setValue("ee", 0);
    exprMgr.setValue("oh", 0);

    for (const [name, weight] of resolved) {
      exprMgr.setValue(name, weight);
    }
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
      phase: "cursor-attention",
      note: "cursor attention sample",
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
    const targets = STATE_EXPRESSIONS[state];
    for (const [name, value] of targets) {
      this.stateExprSlots.push(this.expressions.addSlot(name, value));
    }
  }

  /** Gradual relaxed expression after idle threshold. */
  private updateRelaxed(delta: number): void {
    if (this.eyeSystem.state !== "idle") return;
    this.idleElapsedTime += delta;

    this.relaxedValue = Math.min(
      Math.max((this.idleElapsedTime - RELAXED_THRESHOLD_S) / RELAXED_RAMP_S, 0),
      RELAXED_MAX,
    );

    if (this.relaxedValue > 0) {
      if (this.relaxedSlotId === -1) {
        this.relaxedSlotId = this.expressions.addSlot("relaxed", this.relaxedValue);
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

export { AnimationPlayer } from "./animation-player";
export { BlinkSystem } from "./blink-system";
// Re-export subsystem types for testing
export { ExpressionManager, expressionTargetToName } from "./expression-manager";
export { type EyeState, EyeSystem, gazeTargetToAngles } from "./eye-system";
export { EyelidExpressionController } from "./eyelid-expression-controller";
export { IdleSquintSystem } from "./idle-squint-system";
export { ProceduralBones } from "./procedural-bones";
