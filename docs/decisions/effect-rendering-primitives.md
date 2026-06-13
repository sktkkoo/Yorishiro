# Effect rendering primitives — 種類別に複数並列

**Status**: active
**Last updated**: 2026-04-19

## TL;DR

effect の rendering primitive は **種類別に複数並列** で持つ（filter / particle / canvas 2D / DOM / Three.js）。単一の抽象に押し込まない。今は `addShakeFilter` のみ実装済み。次は `drawOnCanvas`（軽量、init.js にある fireworks 描画コードを効率的に移植できる）。`addParticles` は particle 系が複数になって重複 / 不統一が辛くなってから足す — speculative abstraction を避ける。

---

## 何を決めたか

### primitive taxonomy

| 種類 | 例 | primitive | 現状 |
|---|---|---|---|
| Filter | shake, flash, desaturate | `addShakeFilter` / `addCssFilter` | 両方実装済み |
| Particle（宣言） | sparkle, snow | `addParticles` | 未実装、**今は足さない** |
| Canvas 2D | fireworks, brush art | `drawOnCanvas` | 未実装、**次に足す** |
| DOM manipulation | TextPhysics | `addDomLayer` | 未実装、TextPhysics 着手時 |
| Three.js scene | shader mesh, 3D object | `addThreeLayer` | 未実装、Three.js effect 着手時 |
| Three.js postprocess | bloom, blur | `addThreePostPass` | 未実装、postprocessing 着手時 |

`addShakeFilter` / `addCssFilter` / `addParticles` / `drawOnCanvas` は `RendererAPI` に既に型宣言がある（`src/sdk/context.d.ts:587-598`）が、実装は `addShakeFilter` のみ。`addDomLayer` / `addThreeLayer` / `addThreePostPass` は本決定で将来足す primitive として新規提案。

### 追加順序（推薦）

1. **drawOnCanvas** — fireworks などの 2D 描画 effect を動かすため。init.js の生 DOM 描画コードをそのまま移植できる
2. **addDomLayer / addThreeLayer** — TextPhysics / shader effect に着手する時に個別に足す
3. **addParticles** — particle 系 effect が複数になって「重複が辛い / 肌触りが不統一」が見えたら抽象化（帰納）
4. **addThreePostPass / addCssFilter** — 具体的 need が出た時

### 「生 DOM を pack に渡さない」の本当の意味

effect pack は dynamic `import()` で同一 browser context に load されるため、**技術的には `window` / `document` にアクセスできる**。`sandbox` / iframe / Worker は使っていない。にも関わらず `EffectContext` に DOM root を出していない理由は、以下 4 つ：

1. **lifecycle 保証**: primitive 経由なら `Disposable` 契約で runtime が cleanup を保証できる。pack が leak しても runtime 側で救える
2. **scope 制限**: pack は渡された overlay root だけ触れる。terminal pane や sidebar には介入できない
3. **future sandboxing 余地**: 将来 packs を iframe / Worker に移す日、primitive 経由なら proxy で繋げる（生 DOM 依存だと破綻）
4. **philosophy の契約化**: `src/sdk/context.d.ts:203-208` で effect は "passive renderer" と書かれている。生 DOM 自由は observer / actor 境界を崩す

---

## なぜそう決めたか

### 1. effect の多様性は 1 primitive では吸収できない

particle / canvas 2D / DOM / WebGL は描画 model が根本的に違う：

- particle は「emitter が粒を撒く」の abstraction
- canvas 2D は「pixel に 2D 命令で描く」
- DOM は「既存または新規の HTMLElement を操作」
- WebGL / Three.js は「GPU に shader で描かせる」

1 つの `RendererAPI` method に押し込むと、どれか 1 つに偏って他が描けない（[separate-distinct-systems.md](separate-distinct-systems.md) — 表面的類似で統合しない）。

### 2. Speculative abstraction を避ける

CLAUDE.md の working principles：

- 「Large diff は質 / 体験の gain で代償を払う」
- 「感触 parameter は帰納的に決める」

effect が 1-2 個しか無い phase で 4-5 primitive の API を先に固めると：

- 実装時に API が実際の need と hit しない drift が起きる
- 本体が抱える「肌触り parameters」（gravity / drag / color curve）を推測で書くことになる
- 後で書き直しになる確率が高い

現実の需要が見えた primitive から足していく。

### 3. drawOnCanvas が最小 gain の最初の一歩

- 今の init.js fireworks 描画 loop がそのまま移植できる（sunk cost を回収）
- addParticles で書ける effect は全部 drawOnCanvas でも書ける（addParticles は上位抽象化）
- 本体の実装が軽い（overlay canvas の取り回し + dispose のみ）

---

## 検討したが却下した代替案

### A. RendererAPI に全 primitive を最初から揃える（addParticles + drawOnCanvas + addDomLayer + addThreeLayer を一気に）

却下理由: effect が 1 個（fireworks）しか見えていない phase で 4-5 primitive の API を先に固めると drift が起きる。speculative abstraction そのもの。「感触 parameter は帰納的に決める」に反する。必要になった時に足す方が筋。

### B. addParticles を基盤にする（fireworks も TextPhysics も shader も particle system で表現する）

却下理由:
- 本体に particle engine（gravity / drag / color curve の tuning）を抱えることになり実装重
- TextPhysics / shader には model が合わない（DOM / WebGL とは別軸）
- fireworks 1 個のために speculative に entire engine を書くのは over-engineering
- drawOnCanvas で十分書ける。addParticles は後から「重複が辛い」と感じた時の抽象化として足す順序が正しい

### C. effect pack に生 DOM / 生 WebGL access を自由に渡す（primitive 抽象化しない）

却下理由:
- lifecycle 管理が pack 任せになり、leak で runtime cleanup が効かない
- pack が terminal pane / sidebar に介入できる（scope 制限なし）
- 将来 packs を sandbox したくなった時、既存 pack が全部壊れる
- philosophy の「effect = passive renderer」が contract として守られない

ただし **init.js は例外**: keyboard shortcut / startup hook のため、生 DOM access が許される自由記述層として別扱い（`/charm` doc で明示）。

---

## この決定の implication / 制約

- effect pack は `RendererAPI` の primitive 経由で描画する。`document` / `window` / `THREE` への直接アクセスは「技術的には書けるが SDK contract 外」
- **init.js は例外層** — 生 DOM アクセスが contract として許される。ただし effect pack ではない
- 新 effect pattern を作る時は先に「既存 primitive に hit するか」判定。hit しなければ新 primitive を提案 → 本体追加 → pack 実装、の順番
- `RendererAPI` の拡張は非破壊の方向（既存 method を消さない / signature を変えない）を守る
- **drawOnCanvas が入ったら**: 現在 init.js にある生 DOM fireworks 実装 → effect pack に移植する。init.js は keydown で `ctx.dispatchEffect({ kind: "fireworks", ... })` を叩くだけに痩せる

---

## 関連 reference

- source: `src/sdk/context.d.ts:587-598` — `RendererAPI` interface
- source: `src/sdk/context.d.ts:203-208` — effect = passive renderer の契約
- source: `src/core/space/renderer.ts` — `Renderer` 実装（現状 `addShakeFilter` のみ、他は throw）
- source: `src/core/space/effect-pack-runner.ts` — pack を dispatcher に bind
- source: `src/core/space/effect-dispatcher.ts` — kind 別 pub/sub
- source: `src/runtime/user-pack-loader/init-script.ts` — init.js runner（`CharminalInitContext`）
- doc: `src-tauri/resources/charminal-plugin/commands/charm.md` — `/charm` での effect pack / init.js ガイド
- philosophy: `docs/philosophy/PHILOSOPHY.ja.md` 「六要素 > 空間」
- decision: [separate-distinct-systems.md](separate-distinct-systems.md) — 表面的類似で統合しない
- decision: [presence-over-spectacle.md](presence-over-spectacle.md) — visual layer は実在感の増幅が第一

---

## 改訂履歴

- 2026-04-19: 初版（fireworks 実装を契機に、rendering primitive の taxonomy / 追加順序を topic 化）
- 2026-04-19: `drawOnCanvas` 実装時に `Renderer` へ `RendererDomFactories` seam を追加（jsdom / happy-dom を入れず、node test 環境で DOM 依存を inject する方針）。primitive が 3 つ以上（addDomLayer / addThreeLayer）になったら jsdom 導入を再検討する
