/**
 * EventBus — DispatchEvent の dispatcher。登録済み Trigger を match し、handler を async schedule する。revelation 3.19 の runtime contract 5 項目（max depth 4 / sync dispatch / timestamp backfill / cooldown start / per-pack bound source）を実装する load-bearing piece
 *
 * Philosophy: docs/PRESENCE_HARNESS.md「Twin-trigger co-emission」+「Synthetic event」
 * SDK surface: src/sdk/reaction.d.ts の DispatchEvent / Trigger / TriggerMatch / ReactionEvent
 *
 * 本 skeleton は Phase 3.3(g.1) で配置。real 実装は g.3 で TDD 予定。
 */
export class EventBus {}
