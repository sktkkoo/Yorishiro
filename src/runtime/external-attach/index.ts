export {
  createExternalAttachController,
  type ExternalAttachController,
  type ExternalAttachControllerDeps,
} from "./controller";
export {
  type ExternalAttachCommand,
  type ExternalAttachMode,
  type ExternalAttachSignal,
  type ExternalAttachState,
  type ExternalAttachTransition,
  INITIAL_EXTERNAL_ATTACH_STATE,
  transitionExternalAttach,
} from "./state-machine";
