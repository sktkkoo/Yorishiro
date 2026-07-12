import { SpringBackend } from "./spring-backend";
import type { BodyResponseParams, BodyResponseSimulator, SkeletonDefinition } from "./types";

export { TENTATIVE_RESPONSE_DEFAULTS } from "./default-params";
export type {
  BodyResponseParams,
  BodyResponseSimulator,
  CorrectionPose,
  ForceEvent,
  JointDefinition,
  Pose,
  Quat,
  ResponseBackend,
  SkeletonDefinition,
  Vec3,
} from "./types";

export function createSimulator(
  skeleton: SkeletonDefinition,
  params?: Partial<BodyResponseParams>,
): BodyResponseSimulator {
  return new SpringBackend(skeleton, params);
}
