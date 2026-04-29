# Critical Constraints — 設計上破ってはいけない line

> このファイルは「**設計判断で line を踏みそうな時 / 新しい API を生やす前**」に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-25

これらは Charminal の architecture と思想の核を成す **不可侵な制約**。それぞれの「なぜ」を理解しないまま破ると、既存 code の前提が崩れて雪崩が起きる。実装で迷ったら **まずこのページを引いて該当条項を確認する**。

> CLAUDE.md「Critical constraints to honor」section の expansion。CLAUDE.md は箇条書き、こちらは各制約の **理由** と **判定ガイド**。

---

## 1. PTY は observation only

### Rule

`claude.input` のような **PTY に書き込む API は存在しない**。perception primitive は PTY output を **読むだけ** で、persona / utility / runtime のどこからも write できない。型レベルで強制されている（API がそもそも生えていない）。

### Why

- **観察するが干渉しない** という ICI 原則の最も strict な形（[docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「観察の境界」](../philosophy/INHABITED_CHARACTER_INTERFACE.md)）
- もし persona が PTY に書き込めると、Claude の judgment を構造的に hack できてしまう（user consent UI を挟んでも本質的に同じ）
- consent-as-whitewashing を **architecture の段階で禁止** することが、誠実さを守る唯一の方法

### Don't

- 「user の許可を取れば書き込んでいいのでは」→ NO。user consent は誠実さを担保しない（白塗り化する）
- 「特定の trigger に限定して write API を生やす」→ NO。grey zone を作らない
- utility / persona から「key を送る」「command を流す」ような副作用を持つ API を追加しない

### Reference

- design-record: `2026-04-11-design-exploration.md` revelation 3.13
- philosophy: [docs/philosophy/INHABITED_CHARACTER_INTERFACE.md](../philosophy/INHABITED_CHARACTER_INTERFACE.md)「観察の境界」
- source: `src/core/perception/perception.ts`（read のみ、write API なし）

---

## 2. Utility は motion-free

### Rule

Utility は system API（exec / fs / notify など）と **抽象 reaction の emit** のみ。`character` / `voice` / `space` の motion 系 API は **UtilityContext に型ごと存在しない**。身体表現は persona 専属。

### Why

- Persona と utility の **責務の clean separation**：utility は「機能的な automation」、persona は「キャラクターの存在感」
- もし utility が motion を触れると、複数 utility と persona の motion 衝突 resolution が指数増大（augment / exclusive / priority …）
- 結果として **BodyScheduler が必要になる場面が persona 内に閉じる** → MVP で BodyScheduler を defer できる正当化

### Don't

- utility pack の中で `ctx.character.expressTrue(...)` のような motion API を呼ばない（型 error になる）
- 「便利だから utility にも一時的に motion API を生やす」→ NO。型レベル境界を壊すと revelation 3.17 の Twin-trigger co-emission idiom が成立しなくなる

### How to apply（境界が曖昧な場面）

「これは utility か persona か」迷う場面では：

- **機能的副作用（exec, fs, notify, log）が主目的** → utility
- **キャラクターの内面 / 身体表現が主目的** → persona
- **両方** → utility で機能を実行 + 完了時に **synthetic event を emit** → persona がそれに反応して motion を出す（= Twin-trigger co-emission）

### Reference

- design-record: `2026-04-11-design-exploration.md` revelation 3.14
- source: `src/sdk/utility.d.ts` — UtilityContext 型定義（character/voice/space 不在）

---

## 3. Synthetic event が handler 内 announcement の正規経路

### Rule

handler の中から **直接 reaction を emit する API は追加しない**。代わりに `ctx.emitEvent(name, payload)` で **synthetic event** を runtime dispatch loop に投入し、trigger match 経由で reaction を発火させる。

### Why

- **Declarative composability の保持**：trigger を見れば全 reaction の発火条件が読める状態を保つ
- 案 A（handler 内 live emit）は temporal model / cascading reaction / cooldown timing の 4 層で破綻する
- synthetic event は handler 処理時間に支配されない timestamp（emit 時点で自動補填）を持つ → cooldown 計測が安定

### Don't

- `ctx.emitReaction(...)` のような API を新設しない
- handler の中で別 reaction を直接 trigger しない

### How to apply

handler 内で「別の event を起こしたい」場合：

```typescript
// NG: 直接 reaction emit（API がない、追加しない）
ctx.emitReaction("startled");

// OK: synthetic event を emit、別の trigger が拾う
ctx.emitEvent("custom-thing-happened", { detail: ... });
```

depth 制限は MVP では 4。これを超える chain は loop 検出で停止。

### Reference

- design-record: `2026-04-11-design-exploration.md` revelation 3.19
- source: `src/runtime/event-bus/event-bus.ts`

---

## 4. Twin-trigger co-emission（utility ↔ persona の正規 idiom）

### Rule

同じ環境 event に対して **utility の機能反応 + persona の存在反応** を emit したい時は、**同じ trigger を二つの pack に独立に書く**（utility 側と persona 側）。utility が persona を直接呼ぶ API は提供しない。

### Why

- utility と persona が **状態を共有しつつ動作は独立** という Presence Harness の原則 6（[docs/philosophy/PRESENCE_HARNESS.md](../philosophy/PRESENCE_HARNESS.md)）
- 一方が落ちても他方が動く（degradation の独立）
- pack の独立 install / disable が壊れない

### Don't

- utility から persona の reaction を直接 trigger する API を追加しない
- utility と persona の trigger を「shared subscription」として 1 個にまとめない

### How to apply

「ファイル保存時に backup を取りつつ Charminal を pleased にしたい」場合：

- utility pack：`onFileSave` trigger → `system.exec("cp ...")` で backup
- persona pack：`onFileSave` trigger → `pleased` reaction
- 両方を user が install すれば co-emission される。片方だけでも動く

trigger 名が同じであることを保証するため、shared helper（synonym detection / trigger name catalog）の検討余地あり。

### Reference

- design-record: `2026-04-11-design-exploration.md` revelation 3.17

---

## 5. Docstring example は generic 名・generic 値で

### Rule

SDK の docstring example は **generic name / generic value** で書く。**test case と同じ具体値を使ってはならない**。

### Why

- Test case の具体値が docstring に leak すると、AI が test 解答を docstring から拾えてしまう
- それは test の integrity（pack 作者 AI が autonomous に思考できているかの signal）を破壊する

### Don't

- docstring 内で `"midnight-cat"` のような flagship persona の id をそのまま例に使わない
- test case の expected output を docstring に書かない

### How to apply

例として：

```typescript
/**
 * @example
 * // OK: generic な値
 * const persona: PersonaDefinition = {
 *   id: "my-persona",
 *   name: "わたし",
 *   ...
 * };
 *
 * // NG: 既存 pack や test の具体値
 * const persona: PersonaDefinition = {
 *   id: "midnight-cat",
 *   ...
 * };
 */
```

### Reference

- design-record: `2026-04-11-design-exploration.md` revelation 3.20

---

## 6. Ambient-ui pack に attention の write 権限を渡さない

### Rule

`AmbientUiContext` に `setSourceTarget` を含めない。pack は `attention.get()` / `attention.subscribe()` で snapshot を**読む**のみ。`AttentionRuntime` の write 権限は `getAttentionRuntime()` を直接呼ぶ runtime 側（= producer 群）に閉じる。

### Why

「住人は世界を観察するが、観察対象を造らない」（[docs/philosophy/INHABITED_CHARACTER_INTERFACE.md](../philosophy/INHABITED_CHARACTER_INTERFACE.md)「観察の境界」）。ambient-ui pack は visual layer であり、attention の意味を**生み出す**存在ではない。pack に write 権限があると、aura pack が「自分の存在を強調するため」に target を強制 emit するような形が物理的に可能になり、attention runtime の semantics が「producer の意味判断の集約」から「pack 自己主張の集約」へ崩れる。型レベルで write を不可にすることで誤用を physically 防ぐ。

### Don't

- `AmbientUiContext` に `attention: AttentionRuntime` を渡す（× write 可能になる）
- pack 側で `getAttentionRuntime()` を直接 import する（× SDK 経由ではない近道）
- 「pack が自分の rect を attention に emit して目立たせる」ような pattern

### How to apply

新しい ambient-ui pack を書くとき：`mount(ctx, container)` の `ctx.attention` で `get()` / `subscribe()` のみ使える状態が**正しい**。setSourceTarget が型エラーになるのが期待動作（型エラーが出ないなら SDK 側を疑う）。

### Reference

- `src/sdk/ambient-ui-pack.d.ts`：`AmbientUiContext { attention: AttentionAPI }`（read-only API）
- `src/sdk/attention.d.ts`：`AttentionAPI`（get / subscribe のみ）と `AttentionRuntime extends AttentionAPI`（setSourceTarget 追加）の型分離
- philosophy：[docs/philosophy/INHABITED_CHARACTER_INTERFACE.md](../philosophy/INHABITED_CHARACTER_INTERFACE.md)「観察の境界」
- 内部 design-record：`2026-04-25-attention-aura-v2-design.md`「Surface / SDK 設計」section

---

## 制約間の関係

```
PTY observation only ─┐
                      ├─ → 「観察するが干渉しない」原則の三段適用
Utility motion-free ──┤    （utility が persona の領域に踏み込まない、
                      │     persona が PTY に踏み込まない、
Ambient-ui write-free ┘     pack が attention を造らない）

Synthetic event ─┐
                 ├─ → declarative composability の保持
Twin-trigger ────┘    （runtime 層の dispatch model の clean さ）

Docstring example generic ─→ AI 評価系の integrity 保護
```

6 つの制約は独立に成立するが、根底に **「境界を型レベルで強制し、grey zone を許さない」** という一貫した design discipline がある。

---

## 改訂履歴

- 2026-04-25: Section 6 追加（ambient-ui pack の attention write 境界を記録。観察の境界原則の visual layer への適用）
- 2026-04-19: 初版（CLAUDE.md「Critical constraints to honor」section の topic 別 expansion として作成）
