# Decisions — topic-indexed 決定 / 制約 log

> このファイルは「**topic から最新の決定を 1 ページで掴みたい**」時の入口。対象：dev / AI。各 entry は「結論 + 理由 + 代替案 + 改訂履歴」を 1 ページに集約。

このディレクトリは、Charminal の設計上の **決定** と **制約** を **topic 軸**で引けるようにした index。`../Charminal-design-record/` (date-indexed) を補完する。

---

## なぜこれが必要か

design-record は **date-prefixed** で、設計の **過程** を時系列で記録する。一方で実装中によくあるのは：

> 「persona の取り扱いってどうなってたっけ？」「PTY に書き込めない理由は？」「scene と effect は両方とも pack だけど扱いはどう違う？」

こういう疑問は **topic 軸** で生まれる。date を辿って当該 revelation を探すのは時間がかかる。さらに、決定が後から **修正・無効化** されることもある（revelation 3.2「複数 persona の meta-identity」→ 実装時に「複数 active は実用上不可、single-active に converge」など）。最新の topic 軸 view がないと、古い決定を最新と勘違いする事故が起きる。

このディレクトリの目的は **「topic から最新の決定を一発で引ける」状態** を作ること。

---

## いつ書くか / 更新するか

新規エントリを書くべきタイミング：

1. **revelation や spec で新しい制約が固まった時**（design-record の決定を topic 軸に index する）
2. **過去の決定を実装中に修正・無効化した時**（最重要。この瞬間に書かないと忘れる）
3. **「user との会話で intent が divergent していた」事故が起きた時**（同じ事故を防ぐ）

更新する時：

- 既存エントリの結論が変わったら、エントリ本体を書き直し、末尾に **改訂履歴** を追記
- 削除はしない（過去にこの決定があった事実は、archeological value がある）
- 書き直しが大きい場合は新しいエントリを作って旧エントリから link

---

## ファイル format

各エントリは以下の structure：

```markdown
# {Topic タイトル}

**Status**: active / superseded / partial（一行）
**Last updated**: YYYY-MM-DD

## TL;DR
3 行以内で結論。

## 何を決めたか
具体的な事実。

## なぜそう決めたか
理由 / 根拠。

## 検討したが却下した代替案
あれば。なぜ却下したかも。

## この決定の implication / 制約
これに沿うと future work で何ができて何ができないか。

## 関連 reference
- design-record file (date prefix)
- 該当 source code (path:line)
- philosophy doc の section
```

---

## Topic 索引

### 設計境界（破ってはいけない line）

- [**critical-constraints.md**](critical-constraints.md) — 5 つの絶対制約（PTY observation only / harness motion-free / synthetic event / twin-trigger co-emission / docstring example generic）

### Persona / Identity

- [**persona-multi-instance.md**](persona-multi-instance.md) — 複数 persona 並行 active は不可、single-active が正解（Claude Code additive system prompt 制約由来）

### Pack system

- [**pack-override-pattern.md**](pack-override-pattern.md) — user pack が bundled を override する semantic（dispose + 置換、reference 比較で listener fire）
- [**bundled-pack-immutability.md**](bundled-pack-immutability.md) — bundled は本体の一部、全経路で編集不可、改変は user fork で
- [**single-active-config-picks.md**](single-active-config-picks.md) — single-active な pack は config で user picks、pack 自薦の `defaultActive` は持たせない
- [**user-pack-layout.md**](user-pack-layout.md) — user は flat layout (.js)、bundled は kind-first (.ts)、意図的に非対称
- [**user-init-script-seed.md**](user-init-script-seed.md) — `~/.charminal/init.js` は初回だけ雛形を seed、既存 file は touch しない。app bundle 内設置は採らない
- [**explicit-over-implicit-ugc.md**](explicit-over-implicit-ugc.md) — Agentic UGC 前提では implicit な便利さより explicit な予測可能性
- *UI pack（5 つ目の pack kind）は Plan 3 完了まで shape が変わるため、この topic-indexed index には未 promote。内部 design-record `2026-04-21-ui-pack-single-active.md` を参照*

### Design discipline / compass

- [**cognitive-load-design-lens.md**](cognitive-load-design-lens.md) — 設計 / refactor 判断の lens：「読者が追跡する layer を減らす / 保持する state を減らす」の 2 原則。over-abstraction を見抜く判定軸込み
- [**separate-distinct-systems.md**](separate-distinct-systems.md) — 表面的類似で統合しない、動作モデルが違えば別 concept で
- [**presence-over-spectacle.md**](presence-over-spectacle.md) — visual layer は実在感の増幅が第一、shoost 的な過剰演出は合わない
- [**interaction-as-presence.md**](interaction-as-presence.md) — 意味ある interaction は presence の核、mechanical reactivity（hover glow / parallax 等）は採らない

### Architecture

- [**single-active-registry-pattern.md**](single-active-registry-pattern.md) — 新しい single-active pack 種別を追加する時の extend recipe。`SingleActiveRegistry<TEntry, TValue>` を extend して domain alias 2 個を生やすだけ、実装をコピーしない
- [**codex-terminal-agent.md**](codex-terminal-agent.md) — `terminalAgent` config で Claude Code / Codex を選ぶ。Codex は `developer_instructions` で persona overlay を渡し、base instructions は置換しない
- [**effect-rendering-primitives.md**](effect-rendering-primitives.md) — effect の rendering primitive は種類別に複数並列（filter / particle / canvas 2D / DOM / Three.js）。drawOnCanvas → addDomLayer / addThreeLayer → addParticles の順で帰納的に足す
- [**pack-execution-classes.md**](pack-execution-classes.md) — Pack `type` は product semantics、`executionClass` は security boundary。declarative / isolated-js / trusted-main-thread-js の 3 class を分離。公開 harness は `isolated-js` 完成後の future scope
- [**mcp-trust-tiers.md**](mcp-trust-tiers.md) — Charminal の MCP 3 階層（Tier 1 host / Tier 2 住人 / Tier 3 外部）。各 tier の tool category access policy。PTY 系 tool は当面全 tier で禁止（whitelist validation + length cap + trust tier gate + content layer 防御の 4 層が揃うまで）
- *（今後の追加候補）* `living-system-and-hot-reload.md` — TS が canonical runtime、Rust は IO 層のみ、Claude Code session は HMR で切らない
- *（今後の追加候補）* `core-vs-pack-vs-mcp.md` — core 機能 vs pack vs MCP tool の判断軸（2026-04-19-core-mcp-pack-layers.md の topic 化）

### Reflex / Reaction

- [**motion-effect-trigger-axes.md**](motion-effect-trigger-axes.md) — motion / effect 発火経路の 3 axes（persona / effect / system inline）。system reaction trigger（旧 `builtInTriggers`）は廃止
- *（今後の追加候補）* `synthetic-event-mechanism.md` — handler 内 emit ではなく synthetic event で announce（revelation 3.19）
- *（今後の追加候補）* `twin-trigger-co-emission.md` — harness と persona の正規 idiom（revelation 3.17）

> 「今後の追加候補」は新エントリ追加時 or 関連実装変更時に書き起こす。**書く前から候補を全部埋めない**（drift 源 + 書く動機薄れる）。

---

## 書かないもの

- code を読めば分かること（型定義、関数 signature、import 関係）
- git log で分かること（誰がいつ何を変えた）
- 思想 narrative（→ `docs/philosophy/`）
- 半生の思考過程（→ `../Charminal-design-record/`）

「**Topic から検索して、最新の **結論** を 1 ページで掴む**」ためだけの場所。
