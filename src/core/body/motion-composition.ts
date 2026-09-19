import type { MotionConversationPhase } from "./index";
import type { MotionContext, MotionIntent } from "./motion-catalog";
import type { CompiledMotionProfile, MotionProgram, MotionProgramRole } from "./motion-profile";
import type { MotionRequest } from "./motion-scheduler";

export interface MotionCompositionInput {
  enabled: boolean;
  moving: boolean;
  claimed: boolean;
  activity: string;
  phase: MotionConversationPhase;
  ungroundedSpeech: boolean;
  relaxed: boolean;
  recordedActive: boolean;
  recordedOwnsUpper: boolean;
  scheduled: Readonly<MotionRequest> | null;
  postureActive: boolean;
  occasionalActive: boolean;
}

export interface MotionCompositionPlan {
  readonly support: {
    readonly recorded: boolean;
    readonly fallback: boolean;
    readonly upper: boolean;
  };
  readonly axialAccents: boolean;
  readonly grants: Readonly<Record<MotionProgramRole, boolean>>;
  readonly ambient: {
    readonly enabled: boolean;
    readonly blocked: boolean;
    readonly context: MotionContext;
    readonly intent: MotionIntent;
  };
  readonly hardCancel: boolean;
  readonly exclusivePerformance: boolean;
  readonly recordedSupportActive: boolean;
}

/**
 * Owns composition, not request priority. Scheduler remains the only arbiter.
 * Committed lower owners remain here throughout physical recovery, even after
 * the scheduler has completed or released their handles.
 */
export class MotionCompositionController {
  private readonly lowerOwners = new Set<number>();
  private readonly plan = {
    support: { recorded: false, fallback: false, upper: false },
    axialAccents: false,
    grants: { ambient: false, posture: false, occasional: false, speech: false },
    ambient: {
      enabled: false,
      blocked: true,
      context: "idle" as MotionContext,
      intent: "neutral" as MotionIntent,
    },
    hardCancel: false,
    exclusivePerformance: false,
    recordedSupportActive: false,
  };

  constructor(readonly profile: CompiledMotionProfile) {}

  commit(token: number, mask: "upper-body" | "lower-body" | "full-body" | undefined): void {
    if (mask !== "upper-body") this.lowerOwners.add(token);
  }

  settled(token: number): void {
    this.lowerOwners.delete(token);
  }

  get exclusivePerformance(): boolean {
    return this.lowerOwners.size > 0;
  }

  admits(program: MotionProgram, plan: MotionCompositionPlan): boolean {
    return (
      this.profile.byAnimation.get(program.entry.animation) === program &&
      plan.grants[program.role] &&
      (!program.composition.requiresRecordedSupport || plan.recordedSupportActive)
    );
  }

  resolve(input: MotionCompositionInput): MotionCompositionPlan {
    const exclusivePerformance = this.exclusivePerformance;
    const hardCancel = input.claimed || exclusivePerformance;
    const supportAllowed = input.enabled && !hardCancel;
    const speaking = input.phase === "assistant-speaking";
    const quietPhase = input.phase === "idle" || input.phase === "disconnected";
    const ordinary = input.activity === "idle" || input.activity === "thinking";
    const activeProgram =
      input.scheduled && this.profile.byAnimation.get(input.scheduled.animation);
    const ownAmbient = input.scheduled?.source === "idle" && activeProgram?.role === "ambient";
    const ownPosture = input.scheduled?.source === "idle" && activeProgram?.role === "posture";
    const ownOccasional =
      input.scheduled?.source === "idle" && activeProgram?.role === "occasional";
    const free = input.scheduled === null;
    const available =
      supportAllowed && input.moving && (ordinary || speaking) && !input.ungroundedSpeech;
    const recorded = supportAllowed && this.profile.support.recorded;
    const upper = recorded && (speaking || (input.activity === "idle" && quietPhase));
    const posture =
      available &&
      input.recordedActive &&
      ordinary &&
      !speaking &&
      input.phase !== "interrupted" &&
      (free || ownAmbient || ownPosture || input.postureActive);
    const occasional =
      available &&
      input.recordedActive &&
      input.activity === "idle" &&
      quietPhase &&
      (free || ownOccasional || input.occasionalActive);
    const ambientBlocked =
      ownPosture ||
      ownOccasional ||
      input.postureActive ||
      input.occasionalActive ||
      input.recordedOwnsUpper ||
      (!free && input.scheduled?.priority !== "idle-fidget");
    const intent: MotionIntent = speaking
      ? "explain"
      : input.phase === "user-speaking"
        ? "attentive"
        : input.activity === "thinking" || input.phase === "assistant-responding"
          ? "thinking"
          : input.relaxed
            ? "relaxed"
            : "neutral";
    const replaceable =
      free ||
      input.scheduled?.priority === "idle-fidget" ||
      input.scheduled?.priority === "speech-expression";
    const plan = this.plan;
    plan.support.recorded = recorded;
    plan.support.fallback =
      supportAllowed &&
      this.profile.support.fallback &&
      !input.recordedActive &&
      input.moving &&
      (ordinary || speaking) &&
      replaceable;
    plan.support.upper = upper;
    plan.axialAccents =
      available && input.recordedActive && input.activity === "idle" && quietPhase && free;
    plan.grants.ambient = available && !ambientBlocked;
    plan.grants.posture = posture;
    plan.grants.occasional = occasional;
    plan.grants.speech = supportAllowed && input.moving && replaceable;
    plan.ambient.enabled = available;
    plan.ambient.blocked = ambientBlocked;
    plan.ambient.context = speaking ? "speech" : "idle";
    plan.ambient.intent = intent;
    plan.hardCancel = hardCancel;
    plan.exclusivePerformance = exclusivePerformance;
    plan.recordedSupportActive = recorded && input.recordedActive;
    return plan;
  }
}
