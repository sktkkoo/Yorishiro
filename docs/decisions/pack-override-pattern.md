# User pack の override pattern

> このファイルは「**user pack が bundled pack を上書き / 共存する semantic を設計する**」時に読む。対象：dev / AI。

**Status**: active（Scene で確立、persona に retrofit 済み、effect は未対応）
**Last updated**: 2026-04-19

## TL;DR

user pack が同 id の bundled pack を **dispose + 置換** する形で override する。listener fire は **reference 比較**（同 id でも object が変われば fire）。Scene と Persona Registry で実装済み、Effect は未整理。

## 何を決めたか

- 同 id で user pack が bundled を override すると、registry 上で **bundled は dispose され、user に置き換わる**
- listener は **reference 比較**：同 id でも persona / scene object が変わったら fire（id 比較だと miss する）
- user pack を後から dispose した時は bundled を auto-promote しない。promotion 履歴 flag で「別の user pack が同 id で来た時に意図せず active になる」を防ぐ

## なぜそう決めたか

- 「bundled と user の事故的共存」「bundled 常勝」など、決定的でない挙動を排除する
- pack 識別の安定性（id = 概念）と、object 同一性の正確性（state sync）を両立

## 検討したが却下した代替案

- **bundled を残して user を merge** — 想定外の field 漏れ / 期待値二重化の事故源
- **id 比較で listener fire** — 同 id user override で fire しない bug を生む（scene-pack-registry Phase 1 review で発見、persona-registry-impl も同じ修正経験）

## この決定の implication / 制約

- **Effect pack は未対応**：event-driven / 複数並行のため override semantic が未決定。今後 effect に user override を入れる時は Scene の pattern を retrofit する
- 新しい single-active pack 種別を追加するなら、まず Scene Registry の override 実装を読む

## 関連 reference

- source: `src/runtime/persona-registry/persona-registry-impl.ts`、`src/runtime/scene-pack-registry/scene-pack-registry.ts`
- memory: `feedback_pack_override_pattern.md`
- internal design-record: `2026-04-18-scene-pack-registry.md`（非公開）
- 関連: [`bundled-pack-immutability.md`](bundled-pack-immutability.md)、[`single-active-config-picks.md`](single-active-config-picks.md)
