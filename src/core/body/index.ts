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
 * Philosophy: docs/PRESENCE_HARNESS.md "六要素 > 身体"
 * SDK surface: src/sdk/context.d.ts CharacterAPI (262-292)
 */

import type {
  AnimationHandle,
  AnimationRef,
  CharacterAPI,
  ExpressionHandle,
  ExpressionTarget,
  GazeHandle,
  GazeOptions,
  GazeTarget,
  PlayOptions,
} from "@charminal/sdk";
import type { VRM } from "@pixiv/three-vrm";
import { AnimationPlayer } from "./animation-player";
import { BlinkSystem } from "./blink-system";
import { ExpressionManager, expressionTargetToName } from "./expression-manager";
import { EyeSystem, gazeTargetToAngles } from "./eye-system";

// ─── Constants ───────────────────────────────────────────

const BREATHING_AMPLITUDE = 0.005;
const BREATHING_FREQUENCY = 0.8;
const BLINK_EXPRESSION_NAME = "blink";

// ─── Body ────────────────────────────────────────────────

export class Body {
  private readonly vrm: VRM;
  private readonly expressions: ExpressionManager;
  private readonly blinkSystem: BlinkSystem;
  private readonly eyeSystem: EyeSystem;
  private readonly animationPlayer: AnimationPlayer;

  /** Blink system's slot ID in ExpressionManager. -1 when not active. */
  private blinkSlotId = -1;

  /** Track all active expression handles for interrupt(). */
  private readonly activeExprHandles = new Set<BodyExpressionHandle>();
  /** Track all active gaze handles for interrupt(). */
  private readonly activeGazeHandles = new Set<BodyGazeHandle>();

  constructor(vrm: VRM) {
    this.vrm = vrm;
    this.expressions = new ExpressionManager();
    this.blinkSystem = new BlinkSystem();
    this.eyeSystem = new EyeSystem();
    this.animationPlayer = new AnimationPlayer(vrm);
  }

  /**
   * Per-frame update. Call from the render loop.
   * Drives all subsystems and applies to VRM.
   */
  update(delta: number, elapsed: number): void {
    // 1. Animation mixer
    this.animationPlayer.update(delta);

    // 2. Blink
    const blinkValue = this.blinkSystem.update(delta);
    this.updateBlinkSlot(blinkValue);

    // 3. Eye system
    this.eyeSystem.update(delta);

    // 4. Apply expressions to VRM
    this.applyExpressions();

    // 5. Apply eye gaze to VRM
    this.applyGaze();

    // 6. Breathing
    this.applyBreathing(elapsed);

    // 7. VRM spring bones etc.
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
    this.animationPlayer.stopAll();
    this.activeExprHandles.clear();
    this.activeGazeHandles.clear();
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

    // If handler is driving blink, suppress auto-blink
    if (expressionName === BLINK_EXPRESSION_NAME) {
      this.blinkSystem.suppress();
    }

    const handle = new BodyExpressionHandle(
      target,
      intensity,
      slotId,
      this.expressions,
      this.blinkSystem,
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

  private updateBlinkSlot(blinkValue: number): void {
    if (blinkValue > 0) {
      if (this.blinkSlotId === -1) {
        this.blinkSlotId = this.expressions.addSlot(BLINK_EXPRESSION_NAME, blinkValue);
      } else {
        this.expressions.setWeight(this.blinkSlotId, blinkValue);
      }
    } else if (this.blinkSlotId !== -1) {
      this.expressions.removeSlot(this.blinkSlotId);
      this.blinkSlotId = -1;
    }
  }

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
  }

  private applyBreathing(elapsed: number): void {
    this.vrm.scene.position.y = Math.sin(elapsed * BREATHING_FREQUENCY) * BREATHING_AMPLITUDE;
  }
}

// ─── Handle implementations ─────────────────────────────

class BodyExpressionHandle implements ExpressionHandle {
  readonly target: ExpressionTarget;
  readonly requestedIntensity: number;
  private readonly slotId: number;
  private readonly manager: ExpressionManager;
  private readonly blinkSystem: BlinkSystem;
  private readonly registry: Set<BodyExpressionHandle>;
  private released = false;

  constructor(
    target: ExpressionTarget,
    intensity: number,
    slotId: number,
    manager: ExpressionManager,
    blinkSystem: BlinkSystem,
    registry: Set<BodyExpressionHandle>,
  ) {
    this.target = target;
    this.requestedIntensity = intensity;
    this.slotId = slotId;
    this.manager = manager;
    this.blinkSystem = blinkSystem;
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

    // Resume auto-blink if handler was driving blink
    if (expressionTargetToName(this.target) === BLINK_EXPRESSION_NAME) {
      this.blinkSystem.resume();
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
export { EyeSystem, gazeTargetToAngles } from "./eye-system";
