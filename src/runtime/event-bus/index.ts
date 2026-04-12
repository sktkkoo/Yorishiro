/**
 * EventBus barrel。real 実装は `./event-bus` にある。
 *
 * Philosophy: docs/PRESENCE_HARNESS.md「Twin-trigger co-emission」+「Synthetic event」
 * SDK surface: src/sdk/reaction.d.ts の DispatchEvent / Trigger / TriggerMatch / ReactionEvent
 *
 * revelation 3.19 runtime contract の実装。Phase 3.3(g.3) で TDD 実装。
 */

export {
  EventBus,
  type EventBusDeps,
  type EventBusLogger,
  type PackSource,
  type ReactionHandler,
  type Registration,
} from "./event-bus";
