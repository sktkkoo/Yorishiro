# init.js の hot reload

> このファイルは「**init.js を編集したとき何が起きるか / なぜ pack のように自動反映しないか**」で設計判断する時に読む。対象：dev / AI / pack 作者。

**Status**: active（v2：opt-in scope を畳む in-place hot reload） / auto-capture 方式は依然却下
**Last updated**: 2026-06-28

## TL;DR

**init.js は hot reload する（v2）。ただし pack のような runtime auto-capture ではなく、init.js が `ctx` 経由で明示的に登録した副作用（`ctx.registerShortcut` / `ctx.onDispose`）だけを「scope」として畳む方式にする。** 保存すると watcher が init.js を staging scope で再実行し、成功したら旧 scope を dispose してから差し替える（失敗したら staging を捨て旧 scope を温存）。v1 で却下したのは **runtime auto-capture**（危険な global を wrap して自動で逆操作する案）であって、明示登録方式はその両方の失敗モードを構造的に踏まない。`ctx` を通さない top-level の生 `window.addEventListener` だけは依然 reload で leak しうる——これは「`ctx.registerShortcut` / `ctx.onDispose` を使う」ことで回避する（既定 template もそうしている）。

---

## 何を決めたか

- **init.js は保存で自動反映する（v2）**。watcher の `init-changed` を `reloadInitScript()` に配線する（`src/runtime/user-pack-loader/watcher.ts`）。
- 後始末は **明示登録した scope のみ**：
  - `ctx.registerShortcut(spec, handler)` — keydown(capture) を張り、Disposable を返し、scope に積む。
  - `ctx.onDispose(cleanup)` — 手書き listener / timer の後始末を scope に積む。
  - `InitScope`（`src/runtime/user-pack-loader/init-scope.ts`）が LIFO で dispose。1 つ throw しても残りは走る。
- **transactional reload**：新 init.js を staging scope で run → `ran === true` なら旧 scope を dispose して差し替え、`ran === false`（import 失敗 / default が function でない / throw）なら staging scope を捨てて **旧 scope を温存**。壊れた保存で動いていた shortcut を失わない。
- watcher の検知ロジック（`watcher-logic.ts`：`init.js` → `init-changed`）は不変。`handleLayerEvent` の no-op 表示を実 reload 呼び出しに置換する。
- title marker は廃止せず **意味を反転**：reload 成功で marker を外し、失敗時だけ marker を付けて手動 reload を促す（`src/App.tsx` `onInitReloaded`）。
- **runtime auto-capture 方式は引き続き却下**（下記「なぜ」）。internal design-record: `2026-05-31-init-js-hot-reload-design.md`（§1–§10 が却下案）と `plans/2026-06-28-init-js-hot-reload-plan.md`（v2）。

## なぜそう決めたか

### init.js が pack と違う点

pack は register API（受付窓口）を通るので runtime が handle を握り、新版の前に旧版を dispose できる（`watcher.ts` `reloadPack`）。init.js は窓口を通さず **ブラウザに直接** 副作用を起こせる（`window.addEventListener` 等）。これが「何でもできる」強みであり、runtime が追跡できない弱みでもある。再実行すると追跡外の副作用が二重・三重に積もる（leak）。

### v2：窓口を「足す」ことで追跡可能にする

v1 の核心は「init.js の副作用は runtime が追跡できない」だった。v2 はそれを **auto-capture（暗黙の追跡）ではなく opt-in API（明示の追跡）** で解く。`ctx.registerShortcut` / `ctx.onDispose` を通った副作用だけが scope に乗り、reload で確実に畳まれる。pack の register 窓口と同じ発想を init.js に小さく持ち込む形で、認知負荷 lens（追跡 layer を増やすな）にも沿う——増えるのは「明示登録された disposable の配列 1 本」だけ。

残る leak は「`ctx` を通さない top-level / default 内の生 `window.addEventListener`」のみ。これは **誤って本体を壊す方向ではなく、ユーザー自身の listener が二重化する方向** なので v1 の auto-capture が抱えた「本体機能を removeEventListener する」致命傷とは質が違う。既定 template を `ctx.registerShortcut` ベースにし、生 listener を使う場合は `ctx.onDispose` と組むよう docs で誘導することで実務上の leak をほぼ消す。

### in-place auto-capture が成立しない（cross-agent review で検証済み）

「危険な global を init 実行中だけ wrap して記録・逆操作する」auto-capture 案は、両方向に壊れる：

- **downstream を誤捕捉**：`ctx.dispatchEffect` は `EffectDispatcher.dispatch` で同期に listener を回す（`src/core/space/effect-dispatcher.ts:23`）。`ctx.setActiveUi` は同期に UI pack の `mount()` を走らせる（`src/App.tsx:2358`、DOM append・listener 張りうる）。init.js が `ctx.setActiveUi(...)` を呼んだだけで UI pack の listener が捕捉対象に紛れ、次回 reload で**本体機能を removeEventListener** してしまう。「同期窓なら誤捕捉を避けられる」という防御は、誤捕捉が同期 fan-out で起きるため無効。
- **top-level を取りこぼす**：`import(?v=mtime)` は default 取得前に module top-level を評価するが、wrapper は default 直前に張る。`export default` の外の `window.addEventListener` はリロード毎 leak。弱い LLM（住人 AI が低精度モデルの可能性）は普通に top-level に書く。

修正（ctx.* 呼び出し中は capture を suspend）は、現在・将来の全同期 fan-out 経路を漏れなく suspend する whack-a-mole で、1 つ忘れれば本体が壊れる。[認知負荷 lens](cognitive-load-design-lens.md)（追跡 layer / 保持 state を増やすな）と「large-diff は質で代償を払う」に反する。**v2 はこの whack-a-mole を回避する**：global を一切 wrap せず、明示登録された disposable しか触らないので、誤捕捉も top-level 取りこぼしによる「本体破壊」も構造的に起きない（top-level の生 listener は user 自身の二重化に留まる）。

### 明示 reload 契約という選択

init.js は本質的に「何でもできる」層。v1 では pack と同じ hot reload 体験を急いで揃えるより Emacs `init.el` 的な「明示 reload 契約」を選んだ。v2 では、auto-capture を避けつつ **opt-in scope** で安全に畳める目処が立ったため hot reload を解禁する。生 JS の自由（top-level 副作用）は残しつつ、推奨経路（`ctx.registerShortcut` / `ctx.onDispose`）を使えば reload 安全、という二層構造にした。

## 将来（v1 の scope 外）

- **top-level leak の縮小**：現状 top-level の生 listener は scope 外。必要なら「default 取得前後で軽量に warn する linter / check:pack 警告」を足し、生 listener には `ctx.onDispose` を促す（破壊はしないが二重化を可視化）。
- **generation token**：複数保存が高速連続したときの reload 競合を debounce / single-flight で抑える（現状は watcher の settle に依存）。本当に問題化したら足す。
- **shortcut 画面**：非コーダー向けに設定画面内（CREDITS と同様の overlay）でショートカット編集 UI を将来検討。`plans/2026-06-28-init-js-hot-reload-plan.md`「Future」参照。実装しても本 hot reload の上に乗る friendlier editor であり、置き換えではない。

## 関連

- 設計の全記録：internal design-record（非公開）`2026-05-31-init-js-hot-reload-design.md`
- v2 計画：`plans/2026-06-28-init-js-hot-reload-plan.md`（design-record）
- 既存の hot reload（pack 側）：`src/runtime/user-pack-loader/watcher.ts`、internal design-record `2026-04-15-hot-reload-and-ugc-hot-swap.md`
- [cognitive-load-design-lens.md](cognitive-load-design-lens.md)
