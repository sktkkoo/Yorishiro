import type { BlinkSystem } from "./blink-system";
import type { ExpressionManager } from "./expression-manager";
import { IdleSquintSystem } from "./idle-squint-system";

const BLINK_EXPRESSION_NAME = "blink";

export interface EyelidExpressionUpdateOptions {
  readonly idle: boolean;
  readonly explicitBlinkActive: boolean;
  readonly relaxedValue: number;
  readonly neutralSlotId: number | undefined;
}

export class EyelidExpressionController {
  private readonly expressions: ExpressionManager;
  private readonly blinkSystem: BlinkSystem;
  private readonly idleSquintSystem: IdleSquintSystem;

  private autoBlinkSlotId = -1;
  private idleSquintSlotId = -1;
  private idleSquintSuppressionToken: number | null = null;

  constructor(
    expressions: ExpressionManager,
    blinkSystem: BlinkSystem,
    idleSquintSystem = new IdleSquintSystem(),
  ) {
    this.expressions = expressions;
    this.blinkSystem = blinkSystem;
    this.idleSquintSystem = idleSquintSystem;
  }

  update(autoBlinkValue: number, delta: number, options: EyelidExpressionUpdateOptions): void {
    const idleSquintValue = this.updateIdleSquint(delta, options);
    this.updateAutoBlinkSlot(idleSquintValue > 0 ? 0 : autoBlinkValue);
    this.updateIdleNeutralWeight(options, idleSquintValue);
  }

  clearIdleSquint(options?: EyelidExpressionUpdateOptions): void {
    if (this.idleSquintSlotId !== -1) {
      this.expressions.removeSlot(this.idleSquintSlotId);
      this.idleSquintSlotId = -1;
    }
    if (this.idleSquintSuppressionToken !== null) {
      this.blinkSystem.resume(this.idleSquintSuppressionToken);
      this.idleSquintSuppressionToken = null;
    }
    if (options) this.updateIdleNeutralWeight(options, 0);
  }

  get hasIdleSquint(): boolean {
    return this.idleSquintSlotId !== -1;
  }

  private updateAutoBlinkSlot(blinkValue: number): void {
    if (blinkValue > 0) {
      if (this.autoBlinkSlotId === -1) {
        this.autoBlinkSlotId = this.expressions.addSlot(BLINK_EXPRESSION_NAME, blinkValue);
      } else {
        this.expressions.setWeight(this.autoBlinkSlotId, blinkValue);
      }
    } else if (this.autoBlinkSlotId !== -1) {
      this.expressions.removeSlot(this.autoBlinkSlotId);
      this.autoBlinkSlotId = -1;
    }
  }

  private updateIdleSquint(delta: number, options: EyelidExpressionUpdateOptions): number {
    const enabled = options.idle && !options.explicitBlinkActive;
    const squintValue = this.idleSquintSystem.update(delta, enabled);

    if (squintValue > 0) {
      if (this.idleSquintSuppressionToken === null) {
        this.idleSquintSuppressionToken = this.blinkSystem.suppress();
      }
      if (this.idleSquintSlotId === -1) {
        this.idleSquintSlotId = this.expressions.addSlot(BLINK_EXPRESSION_NAME, squintValue);
      } else {
        this.expressions.setWeight(this.idleSquintSlotId, squintValue);
      }
      return squintValue;
    }

    this.clearIdleSquint(options);
    return 0;
  }

  private updateIdleNeutralWeight(
    options: EyelidExpressionUpdateOptions,
    extraEyeWeight: number,
  ): void {
    if (!options.idle || options.neutralSlotId === undefined) return;
    this.expressions.setWeight(
      options.neutralSlotId,
      Math.max(0, 1.0 - options.relaxedValue - extraEyeWeight),
    );
  }
}
