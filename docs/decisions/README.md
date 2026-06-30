# Decisions — topic-indexed 決定 / 制約 log

> **Note for international readers:** This directory contains internal design decision records written in Japanese. It is intended for active development and is not translated. For an English overview of the project's design philosophy, see [`docs/philosophy/`](../philosophy/) (the `*.md` files are English; `*.ja.md` are Japanese).

> このファイルは「**topic から最新の決定を 1 ページで掴みたい**」時の入口。対象：dev / AI。各 entry は「結論 + 理由 + 代替案 + 改訂履歴」を 1 ページに集約。

このディレクトリは、Charminal の設計上の **決定** と **制約** を **topic 軸**で引けるようにした index。内部設計記録（非公開、date-indexed）を補完する。外部の読者はこのディレクトリだけで設計意図を追える。

---

## なぜこれが必要か

内部設計記録（非公開）は **date-prefixed** で、設計の **過程** を時系列で記録する。一方で実装中によくあるのは：

> 「persona の取り扱いってどうなってたっけ？」「PTY に書き込めない理由は？」「scene と effect は両方とも pack だけど扱いはどう違う？」

こういう疑問は **topic 軸** で生まれる。date を辿って過去の決定を探すのは時間がかかる。さらに、決定が後から **修正・無効化** されることもある（例：「複数 persona の meta-identity」→ 実装時に「複数 active は実用上不可、single-active に converge」）。最新の topic 軸 view がないと、古い決定を最新と勘違いする事故が起きる。

このディレクトリの目的は **「topic から最新の決定を一発で引ける」状態** を作ること。

---

## いつ書くか / 更新するか

新規エントリを書くべきタイミング：

1. **新しい制約が固まった時**（設計上の決定を topic 軸に index する）
2. **過去の決定を実装中に修正・無効化した時**（最重要。この瞬間に書かないと忘れる）
3. **開発中に意図のズレが発見された時**（同じ事故を防ぐ）

更新する時：

- 既存エントリの結論が変わったら、エントリ本体を書き直し、末尾に **改訂履歴** を追記
- 削除はしない（過去にこの決定があった事実は、archeological value がある）
- 書き直しが大きい場合は新しいエントリを作って旧エントリから link

---

## ファイル format

各エントリは以下の structure：

```markdown
# {Topic タイトル}

**Status**: proposed / active / superseded / partial（一行）
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
- 該当 source code (path:line)
- philosophy doc の section
```

---

## Topic 索引

### 設計境界（破ってはいけない line）

- [**critical-constraints.md**](critical-constraints.md) — 5 つの絶対制約（PTY observation only / amenity motion-free / synthetic event / twin-trigger co-emission / docstring example generic）

### Persona / Identity

- [**persona-multi-instance.md**](persona-multi-instance.md) — 複数 persona 並行 active は不可、single-active が正解（Claude Code additive system prompt 制約由来）
- [**arg-mode-abandoned-monitor.md**](arg-mode-abandoned-monitor.md) — ARG モードの軸を旧クライ残留思念に置き、`abandoned-monitor` overlay を廃工場限定の発見経路として扱う

### Pack system

- [**pack-override-pattern.md**](pack-override-pattern.md) — user pack が bundled を override する semantic（dispose + 置換、reference 比較で listener fire）
- [**bundled-pack-immutability.md**](bundled-pack-immutability.md) — bundled は本体の一部、全経路で編集不可、改変は user fork で
- [**single-active-config-picks.md**](single-active-config-picks.md) — single-active な pack は config で user picks、pack 自薦の `defaultActive` は持たせない
- [**user-pack-layout.md**](user-pack-layout.md) — user は flat layout (.js)、bundled は kind-first (.ts)、意図的に非対称
- [**scene-controls-api.md**](scene-controls-api.md) — Scene Pack の lighting / post effect / camera modulation は `useCharminalControls`（`@charminal/sdk/controls`）経由で Scene panel に登録、base camera は Common panel。F2 は Common / Scene の 2 枚。Leva は adapter / debug UI に留める
- [**scene-layer-override-semantics.md**](scene-layer-override-semantics.md) — Scene が layer 構造を握る、override は既存 layer への patch のみ（auto-create 廃止）。scene 切替で override は clear（共通管理 Camera のみ持ち越し）
- [**user-init-script-seed.md**](user-init-script-seed.md) — `~/.charminal/init.js` は初回だけ雛形を seed、既存 file は touch しない。app bundle 内設置は採らない
- [**init-js-hot-reload.md**](init-js-hot-reload.md) — init.js は保存で自動 hot reload する。runtime auto-capture は downstream 誤捕捉 + top-level 取りこぼしで却下し、`ctx.registerShortcut` / `ctx.onDispose` の opt-in scope を畳む
- [**explicit-over-implicit-ugc.md**](explicit-over-implicit-ugc.md) — Agentic UGC 前提では implicit な便利さより explicit な予測可能性
- *UI pack（5 つ目の pack kind）は Plan 3 完了まで shape が変わるため、この topic-indexed index には未 promote*

### Design discipline / compass

- [**cognitive-load-design-lens.md**](cognitive-load-design-lens.md) — 設計 / refactor 判断の lens：「読者が追跡する layer を減らす / 保持する state を減らす」の 2 原則。over-abstraction を見抜く判定軸込み
- [**separate-distinct-systems.md**](separate-distinct-systems.md) — 表面的類似で統合しない、動作モデルが違えば別 concept で
- [**presence-over-spectacle.md**](presence-over-spectacle.md) — visual layer は実在感の増幅が第一、過剰演出は合わない
- [**interaction-as-presence.md**](interaction-as-presence.md) — 意味ある interaction は presence の核、mechanical reactivity（hover glow / parallax 等）は採らない
- [**body-interaction-style.md**](body-interaction-style.md) — 住人の身体性は (B) 滲み出しと UI 操作 を default に。(A) 物理接触（IK で壁押し / カーソル追従等）は禁じないが推奨しない（技術困難 + (B) の方が住人性を本質的に伝える）
- [**autonomy-without-disruption.md**](autonomy-without-disruption.md) — 住人の自発性は user の作業を邪魔しない範囲で設計する。「邪魔しない / でも従属もしない」の二項で居ることを定義。「邪魔になりうることが大事」は退ける
- [**idle-text-physics-removed.md**](idle-text-physics-removed.md) — idle 中に低確率で shoot/TextPhysics を自動発火する旧演出を廃止。shoot は init.js ショートカットの明示発火のみ（侵襲が強く autonomy-without-disruption と非整合）
- [**presence-restore-source-aware.md**](presence-restore-source-aware.md) — prompt 送信時の presence 自動復帰は source 対応。住人発（mcp）の close は「呼ばれたら顔を出す」で復帰、user 発（settings）の明示 close は維持し勝手に開かない

### Architecture

- [**single-active-registry-pattern.md**](single-active-registry-pattern.md) — 新しい single-active pack 種別を追加する時の extend recipe。`SingleActiveRegistry<TEntry, TValue>` を extend して domain alias 2 個を生やすだけ、実装をコピーしない
- [**physiological-reflex-layer.md**](physiological-reflex-layer.md) — 生理反射（startle / 注意切替 / 一息 / 認知瞬き）は persona reaction ではなく Body built-in。event → state mutation axis から発火。表情 preset / motion clip / effect を使うなら演技なので persona 側
- [**motion-intensity.md**](motion-intensity.md) — idle procedural motion の大きさと弾性を `motionIntensity` で調整する。range `0.0`–`3.0` / default `1.0`。settings・SDK・MCP に対称公開し、sway/head/arm は spring + arc で弾性化。短い速い beat は Phase 3 の discrete impulse event に分ける
- [**agent-adapter.md**](agent-adapter.md) — Terminal agent (Claude / Codex / OpenCode / 将来) の adapter 抽象化と capability flag set
- [**session-status-attention.md**](session-status-attention.md) — session ごとの観察 read model（lifecycle / activity / unread / exit / attention）と TabIndicator badge。許可待ち（`input`）は screen fast path を主に、agent hook（手動起動 shell は per-session shim で sessionId attribution）と OSC を fallback に観察し、focus / 出力では消さず、確定入力 / screen 消失 / resume hook で解除する
- [**codex-terminal-agent.md**](codex-terminal-agent.md) — `terminalAgent` config で Claude Code / Codex を選ぶ。Codex は `developer_instructions` で persona overlay を渡し、base instructions は置換しない。Charminal MCP と `$charm-*` skill plugin は session-scoped config で注入する
- [**loop-presence-layer.md**](loop-presence-layer.md) — 自律 agent loop（自動実行）は観察・可視化する presence layer として取り込み、execution engine 化はしない。loop-lifecycle event（6 phase）を `ObservedEvent` 同格で足し、SDK `ctx.loop` と MCP `loop_announce` に対称公開。agent-declared（host 推論しない）/ CC・Codex は `mcp_injection` で両対応 / fearless recovery は Charminal 自身と対象 repo を別軸で扱う
- [**effect-rendering-primitives.md**](effect-rendering-primitives.md) — effect の rendering primitive は種類別に複数並列（filter / particle / canvas 2D / DOM / Three.js）。drawOnCanvas → addDomLayer / addThreeLayer → addParticles の順で帰納的に足す
- [**pack-execution-classes.md**](pack-execution-classes.md) ([English](pack-execution-classes.en.md)) — Pack `type` は product semantics、`executionClass` は security boundary。declarative / isolated-js / trusted-main-thread-js の 3 class を分離。公開 amenity は `isolated-js` 完成後の future scope
- [**pack-sandbox-strategy.md**](pack-sandbox-strategy.md) — Store v1 は declarative + 審査 + 署名で launch、script 実行型 pack は `declarative` → `sandbox: "wasm"` → `sandbox: "native"` の能力ラダーで段階導入。未知 backend / field は fail-closed
- [**scene-execution-sandbox.md**](scene-execution-sandbox.md) — MVP の scene / shader pack 共有は Emacs 的 local trusted model。GitHub 等の pack は `~/.charminal/packs/` に自己責任で置く。VRM と背景 3D の true depth integration は `trusted-main-thread-js`、sandboxed `isolated-js` scene は future public distribution 用の自己完結 layer
- [**utility-pack-deferred.md**](utility-pack-deferred.md) — utility pack（harness→utility）は amenity に supersede（2026-05-14）、型は 2026-05-16 に削除。系譜と archived spec を保持
- [**mcp-trust-tiers.md**](mcp-trust-tiers.md) — Charminal の MCP 3 階層（Tier 1 host / Tier 2 住人 / Tier 3 外部）。各 tier の tool category access policy。PTY 系 tool は当面全 tier で禁止（whitelist validation + length cap + trust tier gate + content layer 防御の 4 層が揃うまで）
- [**input-prefill-boundary.md**](input-prefill-boundary.md) — pack/AI に任意テキスト書込み API を露出しない。(A) host 所有の固定文字列 verb（SDK + MCP 対称、user pack は参照のみ）+ (B) 既存 Reference Marker（write は固定 token、可変内容は MCP read で解決）。mcp-trust-tiers の PTY-prefill 保留条項を安全 subset 分だけ精緻化
- [**voice-clip-resolution.md**](voice-clip-resolution.md) — `ctx.voice.play()` の clip ref を解決する規約。3 種類の ref（shared `voice:<stem>` / pack-local `./...` / playable URL）+ scoped → shared → URL の順で解決。失敗は silent ではなく reject。pack-local ref は path-segment 単位で `.`/`..` 拒否（security 境界）。shared voice の basename alias と filler 同梱は **検証中**
- [**avatar-import-validation.md**](avatar-import-validation.md) — `import_vrm` は symlink / 非 regular file / 非 GLB を拒否し、検証済み handle を直接コピー（TOCTOU 回避）。コピー先 avatars/ が assetProtocol scope 配下のため任意ファイル吸い出しを防ぐ。symlink import と spec 違反 GLB を意図的に弾く（UX より security 優先）
- [**git2-embedded-snapshot-store.md**](git2-embedded-snapshot-store.md) — snapshot store を独自 full-copy から git2（libgit2 vendored）に移行。git dir は `.charminal-snapshots/` に分離（将来の pack 共有 repo と衝突しない）。content-addressed dedup / diff API / system git 非依存
- [**render-on-resize-managed-layer.md**](render-on-resize-managed-layer.md) — `setSize()` は drawing buffer を clear するので resize した frame で必ず render する（ThreeRuntime + procedural-scene-layer の 2 経路で enforce 済み）。作者が自前 renderer を持ち込む `addDomLayer` 経路の再発防止に managed render-layer primitive を **proposed**（未実装）
- *（今後の追加候補）* `living-system-and-hot-reload.md` — TS が canonical runtime、Rust は IO 層のみ、Claude Code session は HMR で切らない
- *（今後の追加候補）* `core-vs-pack-vs-mcp.md` — core 機能 vs pack vs MCP tool の判断軸（2026-04-19-core-mcp-pack-layers.md の topic 化）

### Reflex / Reaction

- [**trigger-reaction-architecture.md**](trigger-reaction-architecture.md) — トリガー・リアクションシステムの統合 architecture overview。event flow / EventBus / PersonaReflexDispatcher / dispatch depth / cooldown / weighted selection / context 境界を一箇所に集約
- [**motion-effect-trigger-axes.md**](motion-effect-trigger-axes.md) — motion / effect 発火経路の 3 axes（persona / effect / system inline）。system reaction trigger（旧 `builtInTriggers`）は廃止

> 「今後の追加候補」は新エントリ追加時 or 関連実装変更時に書き起こす。**書く前から候補を全部埋めない**（drift 源 + 書く動機薄れる）。

---

## 書かないもの

- code を読めば分かること（型定義、関数 signature、import 関係）
- git log で分かること（誰がいつ何を変えた）
- 思想 narrative（→ `docs/philosophy/`）
- 未整理の思考過程（→ 内部設計記録、非公開）

「**Topic から検索して、最新の **結論** を 1 ページで掴む**」ためだけの場所。
