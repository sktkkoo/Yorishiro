export {
  COMMAND_RUN_ATTENTION_PRODUCER,
  type CommandRunAttentionClassification,
  classifyCommandRunAttention,
  DEFAULT_RUNNING_COMMAND_THRESHOLD_MS,
  DEFAULT_SLOW_COMMAND_THRESHOLD_MS,
  type StartCommandRunAttentionProducerOptions,
  startCommandRunAttentionProducer,
} from "./command-run-producer";
export {
  type LightingMood,
  lightingMoodFromAggregate,
  NEUTRAL_LIGHTING_MOOD,
} from "./lighting-mood";
export {
  type StartWorkspaceAttentionPresenceBridgeOptions,
  startWorkspaceAttentionPresenceBridge,
} from "./presence-bridge";
export {
  SESSION_ATTENTION_PRODUCER,
  type StartSessionAttentionProducerOptions,
  startSessionAttentionProducer,
} from "./session-attention-producer";
export type {
  WorkspaceAttentionAggregate,
  WorkspaceAttentionCreateInput,
  WorkspaceAttentionItem,
  WorkspaceAttentionItemState,
  WorkspaceAttentionItemType,
  WorkspaceAttentionLocus,
  WorkspaceAttentionLocusSession,
  WorkspaceAttentionLocusTerminalRegion,
  WorkspaceAttentionMood,
  WorkspaceAttentionProducer,
  WorkspaceAttentionSeverity,
  WorkspaceAttentionSnapshot,
} from "./types";
export { useWorkspaceLightingMood } from "./use-workspace-lighting-mood";
export {
  createWorkspaceAttentionStore,
  getWorkspaceAttentionStore,
  selectPrimaryItem,
  WorkspaceAttentionStore,
  type WorkspaceAttentionStoreOptions,
} from "./workspace-attention-store";
