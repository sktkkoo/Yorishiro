/**
 * @charminal/sdk
 *
 * Charminal Pack を書くための型定義と API の entry point。
 *
 * 使い方：
 * ```typescript
 * import type { PersonaDefinition } from '@charminal/sdk';
 * import type { HarnessDefinition } from '@charminal/sdk';
 * import type { EffectDefinition, EffectContext } from '@charminal/sdk';
 * ```
 *
 * 詳しくは README.md（同じディレクトリ）を参照。
 */

export * from "./reaction";
export * from "./context";
export * from "./persona";
export * from "./harness";
export * from "./effect";
