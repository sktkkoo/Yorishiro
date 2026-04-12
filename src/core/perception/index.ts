/**
 * Perception — 知覚 primitive。環境 event（PTY / hook / idle / window）を観察し DispatchEvent として EventBus に供給する event source
 *
 * Philosophy: docs/PRESENCE_HARNESS.md「六要素 > 知覚」+「認識の境界」
 * SDK surface: src/sdk/reaction.d.ts の DispatchEvent union（59–120, 165）を producer 側として
 *
 * 本 skeleton は Phase 3.3(g.1) で配置。real 実装は Phase 3.5 で TDD 予定。
 */
export class Perception {}
