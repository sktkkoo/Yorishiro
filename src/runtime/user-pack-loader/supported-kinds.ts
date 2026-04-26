/**
 * 現行 Charminal が register 先を持つ pack kind。Phase 1-a では effect と persona
 * のみ、Phase 2 で scene、UI Pack Plan 4 で ui が追加された。attention-aura-v2 で
 * ambient-ui を追加（ambientUiPackRegistry に分岐し、uiPackRegistry とは別空間に閉じる）。
 * 他 (voice / body) は watcher / loader どちらからも skip される。
 *
 * Rust 側 `PACK_KINDS` は discovery 用で、TS 側のこの Set は「register する価値が
 * ある kind」を表す——Phase 1-b 以降で kind を factor out するたびに、こちらと
 * 対応 registrar の配線を足していく。
 *
 * Internal design-record: 2026-04-18-user-layer-runtime.md「user が触れる面積の
 * decision は本格開発の中で段階的に決まる」
 */

export const SUPPORTED_PACK_KINDS: ReadonlySet<string> = new Set([
  "effect",
  "persona",
  "scene",
  "ui",
  "ambient-ui",
]);
