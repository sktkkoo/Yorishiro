# SingleActiveRegistry の extend pattern

> このファイルは「**新しい single-active 系の pack 種別を追加する**」「**SingleActiveRegistry の意図と extend recipe を確認する**」時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-20

## TL;DR

新しい single-active な pack 種別（将来の voice pack / body pack 等）を追加する時は、**`SingleActiveRegistry<TEntry, TValue>` を extend して domain alias method 2 個を生やすだけ**。共通 logic（override / promotion / reference fire / collision warn）は base が持つ。実装をコピーしない。

## 何を決めたか

- single-active pack registry の単一 source of truth は `src/runtime/single-active-registry/`
- 各 specialization（PersonaRegistryImpl / ScenePackRegistryImpl）は **constructor + alias 2 個**の合計 50 行前後
- domain alias 命名：`getActive<Domain>()` / `set<Selection><Domain>(id)`
  - 例：`getActivePersona()` / `setPrimaryPersona()`、`getActiveScene()` / `setActiveScene()`
- entry shape は `SingleActiveEntry`（id + origin）を extend + domain field（`persona` / `scene` 等）
- value extraction は constructor の `extractValue` callback で base に渡す

## なぜそう決めたか

- PersonaRegistry / ScenePackRegistry が同型 134 + 151 行で重複していた（drift 源、1 箇所 fix で他方を忘れる事故）
- 同じ semantic を 2 度学習させる cognitive load
- 一方で **domain alias を残すこと** で call site の readability（`personaRegistry.setPrimaryPersona(config.primaryPersona)` のような自然な読み）を維持

## 新しい specialization を追加する recipe

将来 voice pack のような 3 つ目の single-active 系が増えた場合：

```typescript
// 1. Entry 型を定義（SingleActiveEntry を extend）
import type { PackOrigin } from "../single-active-registry";
export interface VoiceEntry {
  readonly id: string;
  readonly origin: PackOrigin;
  readonly manifest: VoicePackManifest;
  readonly voice: VoiceDefinition;  // domain field
}

// 2. SingleActiveRegistry を extend
import { SingleActiveRegistry } from "../single-active-registry";

export class VoiceRegistryImpl
  extends SingleActiveRegistry<VoiceEntry, VoiceDefinition>
  implements VoiceRegistry
{
  constructor(opts: { warn?: (msg: string) => void } = {}) {
    super({
      extractValue: (entry) => entry.voice,
      label: "VoiceRegistry",
      warn: opts.warn,
      warnOnMultipleBundled: true, // 必要なら
    });
  }

  getActiveVoice(): VoiceDefinition | null {
    return this.getActive();
  }

  setPrimaryVoice(id: string | null): void {
    this.setActive(id);
  }
}

// 3. singleton accessor
export function getVoiceRegistry(): VoiceRegistry {
  return getOrInit(KEYS.VOICE_REGISTRY, () => new VoiceRegistryImpl());
}
```

**test 方針**：base の generic semantic（override / promotion / reference fire 等）は `single-active-registry.test.ts` でカバー済み。specialization 側の test は **「extractValue が正しく `entry.voice` を取り出す」「alias 経由で base が動く」程度の薄い smoke test** で十分。重複 test を書かない。

## 検討したが却下した代替案

### A. abstract class にして hook method を override させる

**却下理由**：specialization ごとに違うのは「extract の対象」と「label」「warn 強度」だけ。template method pattern を導入するほどの分岐がない。constructor opts で十分。

### B. class でなく factory function

```typescript
const personaRegistry = createSingleActiveRegistry({ extractValue: ..., ... });
```

**却下理由**：method-style call (`registry.getActive()`) と function-style call (`getActive(registry)`) で前者の方が call site が読みやすい。class extension で domain alias を生やせるのも利点。

### C. 各 registry に interface を別定義 + base class へ実装委譲

**却下理由**：interface が 1 つしかない specialization に対して interface を新設するのは over-abstraction。`PersonaRegistry` / `ScenePackRegistry` interface はもともと public contract として存在しているので、impl が base を継承する形が自然。

## この決定の implication / 制約

- **multi-active 系の pack（effect 等）はこの base を使わない**。動作モデルが違う（[separate-distinct-systems.md](separate-distinct-systems.md)）。EffectPackRunner は別系統で実装
- specialization の中から base の private method (`computeActive`, `checkBundledCollision`) には触らない（base が canonical な semantic を持つ）
- 新しい semantic（priority / merging 等）が必要になったら **base 側で opt-in option として追加**（specialization で override しない）。これにより全 specialization に均等に効く / 効かない選択ができる
- domain alias の命名は projects が deep に follow している既存 caller の自然さ優先。base の generic 名（`getActive`）を直接 caller に晒すのは avoid

## 関連 reference

### Source

- `src/runtime/single-active-registry/single-active-registry.ts` — base class
- `src/runtime/single-active-registry/types.ts` — `SingleActiveEntry`, `SingleActiveRegistryOptions`
- `src/runtime/persona-registry/persona-registry-impl.ts` — specialization 例 1
- `src/runtime/scene-pack-registry/scene-pack-registry.ts` — specialization 例 2

### Related decisions

- [`separate-distinct-systems.md`](separate-distinct-systems.md) — multi-active 系を base に巻き込まない判断軸
- [`single-active-config-picks.md`](single-active-config-picks.md) — single-active な pack の active 選択 mechanism
- [`pack-override-pattern.md`](pack-override-pattern.md) — user > bundled override の semantic（base に集約）

## 改訂履歴

- 2026-04-20: 初版（PersonaRegistry / ScenePackRegistry の統合 commit `7cfd1ea` を契機に作成）
