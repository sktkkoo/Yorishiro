# Expression intent arbitration と presence coordination seam

**Status**: proposed
**Last updated**: 2026-08-01

## TL;DR

Issue [#83](https://github.com/sktkkoo/Yorishiro/issues/83) の実装範囲は、まず**表情だけ**に限定する。
各 producer と `ExpressionManager` の間に pure policy 層 `ExpressionIntentArbiter` を置き、source、
salience、顔 region、ownership、lifecycle、coexistence をそこで解決する。`ExpressionManager` は引き続き
具体的な morph weight の集約と global weight budget を担う**唯一の expression mixer**である。

body motion と lip sync は同じ arbiter へ入れない。将来は owner / semantic state / salience / lifecycle /
trace を持つ薄い共通 envelope を共有しつつ、motion は `MotionScheduler`、lip sync は連続的な articulation
coordinator、表情は `ExpressionIntentArbiter` という domain 別 coordinator に分ける。単一の
`PresenceManager`、cross-domain priority queue、all-purpose mixer は作らない。

## 背景と現在地

`ExpressionManager` は既に次を持つ。

- concrete expression slot と `(source, kind)` 単位の dedup
- `idle < thinking < speech < persona < mcp/system < reflex` の source priority
- active slot 全体の weight 合計を 1 以下にする proportional scale-down
- requested / effective weight の snapshot
- `ExpressionSinkTracker` を通した VRM expression sink の zeroing

一方、**どの表情を出してよいか**という policy は `Body.update()` と各 subsystem に残っている。

- non-idle mood を見て relaxed / idle squint / idle micro を止める
- speech engagement を見て brow / eye / mouth の idle micro を region 別に止める
- explicit blink handle が `BlinkSystem` の suppression token を直接持つ
- `SpeechMoodChannel` と `speechStateExpressionLayers` が独自の envelope / last-owner policy を持つ
- lip-sync viseme と speech microexpression が `ExpressionManager.writeResolved()` の後で batch を直接変更する
- `ClaimState.expression` が Body の frame orchestration 全体を bypass する

このため、新しい producer は `ExpressionManager` へ slot を置くだけでは足りず、既存 producer の停止条件を
`Body` に追加しがちである。また現 snapshot は「slot の effective weight が 0」までは見えても、region conflict、
owner replacement、ambient suspension、unmapped target など、**なぜその結果になったか**を説明できない。

Issue #79 の Agent State Expression は既に統合済みである。現在は transcript resolver / speech-clock scheduler /
Body adapter を通り、表情は `SpeechMoodChannel` から `speech` mood slot、gesture は `MotionScheduler` の
`speech-expression` lane へ入る。barge-in / stop / disconnect の owner release も実装済みである。#83 はこの
機能を作り直すものではなく、既存の speech expression を最初の shared arbitration consumer に移す follow-up
である。

## Scope

### #83 で行う

- provider / avatar 非依存の `ExpressionIntent` と owner-scoped handle を定義する
- expression producer の admission / suppression / coexistence policy を一箇所へ集める
- semantic intent を concrete `ExpressionManager` slot へ変換する bridge を置く
- active / blended / suppressed / releasing と reason を観察できるようにする
- state base、idle variation、blink、speech state、persona / MCP を段階移行する
- 移行中も現在の source priority、weight budget、public handle behavior を保つ

### #83 では行わない

- `MotionScheduler`、`AnimationPlayer`、procedural bone blend の再設計
- `LipSyncAnalyser`、voice ownership、audio sampling loop の再設計
- persona ごとの semantic state → expression / motion catalog
- gaze / attention arbitration の統合
- expression、motion、lip sync を一つの state machine や mixer へ集約すること

lip sync は顔へ morph を出すが、意味上は emotion intent ではなく高頻度の speech articulation signal である。
#83 の region policy は `mouth/articulation` を予約し、表情がそこを抑止しないことを test する。ただし現在の
direct batch merge を articulation coordinator へ移す作業は、expression arbitration の安定後に別 phase / 別
Decision 更新として扱う。

## 何を決めたか

### 1. `ExpressionIntentArbiter` は policy boundary であり mixer ではない

```text
expression producers
  -> ExpressionIntentArbiter
  -> ExpressionIntentResolver / SlotBridge
  -> ExpressionManager
  -> ExpressionSinkTracker
  -> VRM expressionManager
```

`ExpressionIntentArbiter` の責務:

- intent の acquire / update / release と stale owner protection
- source + salience から fixed priority class を導出する
- region + function lane の overlap と coexistence を判定する
- same-owner replacement、pulse / held / release envelope、TTL を進める
- admitted / suppressed と machine-readable reason を snapshot に残す
- ambient variation の category / intensity 制約を enforce する

`ExpressionIntentArbiter` が**しないこと**:

- morph weight の加算、global budget scale、VRM への write
- animation clip の選択 / 再生、procedural bone gain の計算
- audio sampling、phoneme detection、viseme smoothing
- persona 固有 mapping の所有
- transcript や provider event の解釈

`ExpressionManager` は concrete contribution の requested weight を合成し、global budget を適用する唯一の
numeric mixer として残す。arbiter は intent を admitted / suppressed に分類するだけで、同名 morph の加算や
weight budget を持たない。移行中は既存の `ExpressionManager` source priority を compatibility guard として残し、
全 producer の cutover と parity test が終わるまで削除しない。最終的な policy の正本は arbiter 側とし、manager
側へ新しい region / semantic policy を増やさない。

### 2. semantic intent と concrete contribution を分ける

概念 model は次の情報を持つ。実装時の field 名は test と callsite を見て調整してよいが、意味を落としては
ならない。

```ts
interface ExpressionIntent {
  readonly intentId: string;
  readonly owner: {
    readonly producerId: string;
    readonly scopeId: string;
    readonly generation?: number;
    readonly replacementKey?: string;
  };
  readonly source: "idle" | "thinking" | "speech" | "persona" | "mcp" | "system" | "reflex";
  readonly semantic: {
    readonly role: "baseline" | "grounded-state" | "explicit-action" | "safety-reflex";
    readonly state?: string;
    readonly target?: string;
  };
  readonly occupancy: ReadonlyArray<{
    readonly region: "brow" | "eye" | "eyelid" | "mouth";
    readonly lane: "affect" | "physiology" | "articulation";
  }>;
  readonly salience: "ambient" | "grounded" | "explicit" | "reflex";
  readonly intensity: number;
  readonly lifecycle:
    | { readonly kind: "held"; readonly attackMs?: number; readonly releaseMs?: number }
    | {
        readonly kind: "pulse";
        readonly durationMs: number;
        readonly attackMs?: number;
        readonly releaseMs?: number;
      };
}
```

`semantic.state` は `acknowledging` / `concerned` のような provider-neutral な意味であり、morph 名ではない。
`semantic.target` は host 共通 mapping の key である。既存 persona / MCP API の arbitrary preset / custom morph は、
移行中だけ `direct-target` compatibility resolver で包む。これを persona-specific catalog が決まったこととは
みなさない。

`ExpressionIntentResolver` は admitted intent を one-or-many の concrete contribution に変換する。

```ts
interface ExpressionContribution {
  readonly intentId: string;
  readonly source: ExpressionSource;
  readonly kind: ExpressionKind;
  readonly expressionName: string;
  readonly requestedWeight: number;
}
```

`ExpressionIntentSlotBridge` は intent ごとの manager slot ID を所有し、resolver output の差分を add / update /
remove する。producer は slot ID や morph weight budget を知らない。1 intent が full-face preset または複数 part
morph へ展開されても、release は元の owner handle 一つで閉じる。

現 `ExpressionManager.addSlot()` の `(source, kind)` dedup key は、同じ source の別 owner が同じ region で
coexistence する場合には粗すぎる。bridge 用には `intentId + contribution key` を明示できる keyed slot entrypoint
（または内部 slot key の拡張）が必要である。legacy `addSlot()` の dedup behavior は既存 caller の compatibility
として残し、arbiter が admission 済み contribution を manager 側で意図せず release しないようにする。

`direct-target` の custom morph は region metadata を安全に解決できるものだけ cutover する。`Fcl_BRW_*` 等は
既知 prefix から解決できるが、region 不明の arbitrary morph を推測で分類しない。metadata が無い target は
legacy path に残すか `unmapped-target` として観察し、persona-specific mapping 問題を #83 へ取り込まない。

### 3. conflict key は `kind` だけでなく region + function lane にする

`mood` / `eye` / `custom` は output format の分類であり、semantic conflict の分類には粗すぎる。例えば full-face
mood と `part-brow` は異なる `kind` でも brow では競合し、blink と eye affect は同じ eye 周辺でも physiology と
affect として共存すべきである。

arbiter は `occupancy = region + lane` を policy key にする。

- full-face affect は `brow/affect`、`eye/affect`、`mouth/affect` へ展開する
- blink / idle squint / eyelid reflex は `eyelid/physiology`
- low-level facial microvariation は実際に触る region の `affect` または `physiology`
- lip-sync viseme は将来用に `mouth/articulation` を予約する
- gaze は blendshape ではなく `VRMLookAt` の別 actuator なので expression occupancy に入れない

### 4. priority と coexistence は declarative policy table を正本にする

producer が arbitrary numeric priority を渡す API は作らない。priority class は source、semantic role、salience
から policy が導出する。初期 table は現在の挙動を基準に次の順序を保つ。

| class | 現在の対応 | overlap 時の扱い |
|---|---|---|
| safety reflex | `reflex` の明示的な安全 / 生理反射 | 同じ lane の下位を抑止。affect / articulation とは原則共存 |
| explicit external / system | `mcp`, `system` | overlap する explicit persona / grounded / ambient affect より上 |
| explicit persona / user | `persona`（user action の現行 entrypoint を含む） | grounded / ambient affect より上 |
| grounded conversation | `speech` / Agent State Expression | thinking / idle affect より上。physiology / articulation は抑止しない |
| grounded activity | `thinking` | idle affect より上 |
| ambient baseline | `idle` | overlap する grounded / explicit intent があれば抑止 |

追加 rule:

- 同じ owner + `replacementKey` の新 intent は旧 intent を replace する。古い handle の release は新 owner を
  解放しない。
- 同 class の別 owner は、occupancy が compatible なら blend する。exclusive な同じ occupancy なら deterministic
  な sequence で latest wins とし、reason に winner を残す。
- autonomous blink は mood / grounded state と共存する。explicit eyelid action の間は ordinary auto-blink が
  suspend されるが、`safety-reflex` と tag された反射は documented highest priority を保つ。
- grounded speech mood は overlap する idle affect / microvariation を止めるが、blink と lip sync を止めない。
- ambient producer は `grounded-state` / `explicit-action` を発行できない。ambient の random 選択は allowlist された
  microvariation と弱い intensity / timing に限定し、強い emotion category を発明しない。
- `ClaimState.expression` は通常 intent より上の domain claim である。arbiter の context input として扱い、全 intent
  を silent に消すのではなく `domain-claimed` reason を出す。
- 最後の global weight scale は admission 後に `ExpressionManager` が一度だけ行う。

source priority を複数 file の numeric table に複製しない。migration 中に manager の compatibility priority が必要な
間は、一つの policy mapping から導出するか parity test で差分を固定する。

### 5. ownership は boolean ではなく handle / generation で管理する

realtime voice Decision と同じく、expression lifecycle も owner-scoped にする。

- `acquire(intent)` は `updateIntensity()` / `release()` / `intentId` を持つ handle を返す
- owner は producer + utterance / reaction / request scope + optional generation で識別する
- release / timeout / disconnect は自分が所有する intent だけを解放する
- old generation の timer、audio event、handle release は replacement intent を変更できない
- envelope clock は注入可能にし、attack / release / pulse / late release を unit test 可能にする

`SpeechMoodChannel`、`speechStateExpressionLayers`、persona / MCP expression handle の public behavior は adapter で
維持し、caller を一斉変更しない。ownership policy が arbiter へ移った producer から、旧 last-owner Map や
suppression token を削除する。

### 6. observability は arbitration と numeric mixing の両方を説明する

`ExpressionArbitrationSnapshot` は少なくとも各 intent について次を返す。

- `intentId`, owner, source, semantic role / state, occupancy, salience
- requested intensity と lifecycle phase
- `active | blended | suppressed | releasing | expired`
- reason code と、抑止した intent / claim / region
- concrete contribution へ解決できなかった場合の `unmapped-target`

初期 reason code:

- `lower-priority-overlap`
- `replaced-same-owner`
- `exclusive-tie-lost`
- `ambient-suspended-by-grounded`
- `ambient-policy-rejected`
- `domain-claimed`
- `unmapped-target`
- `released` / `expired`

`ExpressionManager` の requested / effective weight snapshot は残す。read-only な debug facade が arbiter snapshot と
manager slot snapshot を `intentId` で join し、`budget-scaled` を説明する。この facade は制御判断を持たず、
新しい manager にはしない。`state.get` は互換の slot view を維持しつつ、段階的に reason 付き view を追加する。

## Incremental migration

各 step は独立に revert 可能とし、一度に全 producer を切り替えない。

### M0 — 現挙動の characterization

- `ExpressionManager` の source priority / dedup / global budget を golden test 化する
- `Body` の idle squint + blink、speech mood + lip sync、speech micro + idle micro、persona + MCP、expression claim を
  coexistence test として固定する
- Agent State Expression と VRMA / procedural motion の既存 test を regression baseline にする
- debug snapshot に current slot と direct batch contribution を記録できる最小 instrumentation を置く

### M1 — pure types / policy / arbiter

- `src/core/body/expression-intent.ts`
- `src/core/body/expression-intent-policy.ts`
- `src/core/body/expression-intent-arbiter.ts`
- pure unit test（clock、owner replacement、region conflict、reason、ambient guard）

この step では VRM write と既存 producer wiring を変えない。

### M2 — resolver / slot bridge と shadow comparison

- host 共通 semantic mapping + legacy direct-target resolver を追加する
- `ExpressionIntentSlotBridge` を `ExpressionManager` に接続する
- selected producer を intent として shadow 登録し、legacy slot / gate の結果との差を debug log へ出す
- shadow 中は intent 側から VRM を駆動せず、二重 slot / 二重 mixer を作らない

### M3 — ambient / state producer を先に移す

- state base expression
- relaxed expression
- idle squint
- region 別 idle microexpression

低優先 producer から移し、higher-salience intent がない時の見た目を先に安定させる。各 producer の cutover 後にだけ
対応する `Body.update()` の pairwise gate を削除する。

### M4 — speech / Agent State Expression を移す

- `SpeechMoodChannel` の acquire 先を expression intent handle adapter に替える
- speech microexpression を brow / eye の low-intensity grounded contribution として登録する
- `acquireSpeechStateExpression()` の owner stacking を arbiter handle / replacementKey へ寄せる
- user barge-in、voice stop、disconnect で当該 utterance owner だけが release されることを再検証する

Agent State resolver / scheduler と motion gesture lane は変更しない。

### M5 — explicit action と blink / reflex を移す

- `CharacterAPI.express()`、MCP acquire を compatibility intent で包む
- autonomous blink、explicit blink、idle squint、speech-boundary blink の ownership を policy table へ移す
- explicit persona / MCP / system と safety reflex の既存 precedence を parity test で確認する
- old suppression token / source-pair condition は、対応 producer の cutover 後に削除する

### M6 — expression policy の cutover と cleanup

- expression producer が competing subsystem の pairwise condition を参照していないことを確認する
- `Body.applyExpressions()` から semantic suppression と speech micro の post-mix policy を除き、manager resolved
  output の sink orchestrationへ縮める。既存 lip-sync merge は named articulation compatibility seam として隔離し、
  #83 で audio / viseme lifecycle を移さない
- manager の compatibility source arbitration を残す必要があるか、shadow diff と test を根拠に判断する
- reason 付き snapshot を debug / `state.get` へ公開する

M6 完了が #83 の expression scope の完了条件である。motion / lip-sync coordinator はここへ含めない。

## 将来の presence coordination

### 共有するのは value envelope と ownership 語彙だけ

将来、Agent State Expression の一つの semantic cue から表情・motion・lip sync 周辺の調整を関連づける場合、次の
metadata は共有できる。

```ts
interface PresenceCueEnvelope {
  readonly cueId: string;
  readonly owner: { producerId: string; scopeId: string; generation?: number };
  readonly semanticState?: string;
  readonly salience: "ambient" | "grounded" | "explicit" | "reflex";
  readonly issuedAtMs: number;
  readonly lifecycle?: { durationMs?: number; releaseMs?: number };
  readonly trace?: { parentCueId?: string; reason?: string };
}
```

これは data shape であり、runtime singleton や global queue ではない。adapter は一つの envelope から domain intent
を fan-out し、自分が得た handles を owner scope でまとめて release できる。domain coordinator 同士が互いの内部
state を直接 mutate しない。

### Motion: separate `MotionIntentCoordinator`（future）

motion は discrete clip の single-active preemption と、continuous procedural motion の complementary gain を持つ。
region ごとに複数 morph を blend する expression とは動作 model が異なる。

将来必要なら semantic gesture / posture intent を受ける `MotionIntentCoordinator` を置き、clip request は既存
`MotionScheduler`、procedural envelope は `ProceduralBones` / `BreathingSystem` へ委譲する。priority lane、body
region claim、stale motion の drop、active / rejected reason は motion domain で決める。expression の policy table
や mixer を再利用しない。#83 中は現在の `speech-expression` lane と VRMA / procedural complementary blend を維持する。

### Lip sync: separate articulation coordinator（future）

lip sync は 60fps 前後の mutable sample、active audio owner、signal smoothing を持ち、held semantic intent とは異なる。
将来の articulation coordinator は次だけを扱う。

- current audio owner / generation の選択
- `LipSyncAnalyser` からの一 frame 一回の sample contract
- viseme frame の lifecycle と stale source rejection
- `mouth/articulation` contribution の debug state

expression arbiter は articulation lane を suppress しない。将来 direct batch merge を外すときは、狭い frame
contribution bridge から `ExpressionManager` へ viseme を渡し、numeric composition / budget / VRM write の場所を
一つに保つ。ただし viseme の intelligibility を global scale で損なわない budget partition は実機 test を要するため、
#83 では決め打ちしない。

### 作らないもの

- expression / motion / lip sync の全 request を同じ numeric priority で比較する global scheduler
- 全 channel の clock、owner、resource cleanup を一つに抱える `PresenceManager`
- `ExpressionManager` と別に morph weight を集約する composer
- Agent State Expression の一 cue を全 domain で atomic commit する transaction manager

表情だけ出て gesture asset が無い、motion が higher priority に拒否された、audio が無く lip sync が no-op になる、
という partial success は正常である。共有するのは意味と ownership の対応であり、actuator の成否ではない。

## Verification contract

#83 の coexistence test は少なくとも次を含む。

| case | 必須結果 |
|---|---|
| idle neutral + relaxed + idle squint | ambient policy 内で合成され、理由付きで観察できる |
| idle squint + autonomous / explicit / safety blink | ordinary blink の suspension と safety priority を区別できる |
| speech mood + idle micro | overlap する idle variation だけが suppressed |
| speech mood + reflex blink | blink が維持される |
| speech mood / Agent State Expression + lip sync | `mouth/articulation` が維持される |
| Agent State Expression + persona expression | persona が overlap region を所有し、speech intent に suppress reason が残る |
| persona + MCP expression | 現在の MCP precedence を保つ |
| release / barge-in / stale timer | current owner だけが残る |
| expression claim | `domain-claimed` が観察でき、claim release 後に stale write しない |
| expression intent + VRMA / procedural motion | motion snapshot / complementary weight に変化がない |
| total weight > 1 | `ExpressionManager` が一度だけ scale し `budget-scaled` を説明できる |

steady frame では existing runtime-frame-budget contract を守り、snapshot request がない通常 render path で intent /
reason object を毎 frame allocate しない。

## 検討したが却下した代替案

### A. `ExpressionManager` に semantic policy を全部追加する

却下。concrete morph slot / budget mixer と、provider-neutral semantic ownership / region conflict の責務が混ざる。
manager の public surface が Agent State Expression、persona、audio lifecycle を知り始め、mixer を変更するたび producer
policy まで壊れる。

### B. `Body.update()` の pairwise condition を増やし続ける

却下。新 producer が全既存 subsystem を知る構造が #83 の直接原因であり、suppression reason も一箇所で説明できない。

### C. expression / motion / lip sync を一つの composer に入れる

却下。expression は per-region blend、motion は discrete single-active preemption + procedural blend、lip sync は
owner-scoped continuous signal で、競合 model と clock が異なる。表面的な「身体出力」という共通点で統合すると
oversized controller になる。

### D. 一括 migration

却下。idle の微妙な共存、blink suppression、lip-sync direct merge、claim bypass、public handle ownership が同時に変わり、
regression の原因を切り分けられない。shadow comparison と producer 単位の cutover を採る。

## この決定の implication / 制約

- 新しい expression producer は `Body` に pairwise gate を追加せず、intent を submit する
- producer は arbitrary priority、他 producer 名、global weight budget を知らない
- `ExpressionManager` 以外の新しい expression mixer を追加しない
- lip sync / motion の future coordination は別 domain coordinator とし、この arbiter を汎用化しない
- persona-specific mapping は compatibility resolver の存在を理由に既成事実化しない
- #83 の runtime implementation 前に本 Decision の policy / migration sequence を review する

## 関連 reference

- [GitHub issue #83](https://github.com/sktkkoo/Yorishiro/issues/83)
- [codex-realtime-voice.md](codex-realtime-voice.md)
- [separate-distinct-systems.md](separate-distinct-systems.md)
- [physiological-reflex-layer.md](physiological-reflex-layer.md)
- [runtime-frame-budget.md](runtime-frame-budget.md)
- `src/core/body/expression-manager.ts`
- `src/core/body/index.ts`
- `src/core/body/motion-scheduler.ts`
- `src/core/body/speech-mood-channel.ts`
- `src/core/body/speech-microexpression-system.ts`
- `src/runtime/agent-state-expression/`
- `src/core/voice/lip-sync-analyser.ts`

## 改訂履歴

- 2026-08-01 初版：#83 の expression-first arbitration、incremental migration、motion / lip-sync の future seam を決定
