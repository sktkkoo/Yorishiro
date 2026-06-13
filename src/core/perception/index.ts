/**
 * Perception — 知覚 primitive。環境 event（PTY / hook / idle / window）を観察し DispatchEvent として EventBus に供給する event source
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「認識の境界」
 * SDK surface: src/sdk/reaction.d.ts の DispatchEvent union
 */
export { Perception, type PerceptionDeps } from "./perception";
