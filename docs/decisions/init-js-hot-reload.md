# init.js の hot reload

> このファイルは「**init.js を編集したとき何が起きるか / なぜ pack のように自動反映しないか**」で設計判断する時に読む。対象：dev / AI / pack 作者。

**Status**: active（v1：手動リロード + UX 改善） / in-place hot reload は検討・却下
**Last updated**: 2026-05-31

## TL;DR

**init.js は pack と違い hot reload しない。明示 reload 契約（Emacs `init.el` 同様、Cmd/Ctrl+R で反映）を踏襲する。** v1 では「init.js が変わったら気づける」UX だけ足す。pack と同じ in-place hot swap は、副作用の自動後始末（runtime auto-capture）が **downstream を誤捕捉し top-level を取りこぼす**ため却下した。

---

## 何を決めたか

- **init.js は自動反映しない**。保存しても再実行されず、ユーザーが Cmd/Ctrl+R（既存の全 reload）で反映する。
- v1 の UX 改善は次の 3 つのみ：
  1. init.js 変更時に **window title へ suffix**（「— init.js changed (⌘R)」相当、reload まで残り reload で自動消滅）。safe-mode の title-suffix 方式（`src/App.tsx:1016`）と同じ前例に倣う。本体に汎用 toast 機構は無い。
  2. `src/runtime/user-pack-loader/watcher.ts` の `init-changed` dev-log を「reload not supported」から「press Cmd/Ctrl+R to reload」相当へ。
  3. `docs/configuration.md`（既に「init.js は Ctrl+R で反映」と記載）との文言整合。
- watcher の検知ロジック（`watcher-logic.ts`：`init.js` → `init-changed`）は変えない。`handleLayerEvent` の no-op を UX 表示に置換するだけ。
- **in-place hot swap（runtime auto-capture + `ctx.onCleanup` + load-then-swap）は v1 から却下**。設計記録は internal design-record: `2026-05-31-init-js-hot-reload-design.md`（§1–§10 が却下案）。

## なぜそう決めたか

### init.js が pack と違う点

pack は register API（受付窓口）を通るので runtime が handle を握り、新版の前に旧版を dispose できる（`watcher.ts` `reloadPack`）。init.js は窓口を通さず **ブラウザに直接** 副作用を起こせる（`window.addEventListener` 等）。これが「何でもできる」強みであり、runtime が追跡できない弱みでもある。再実行すると追跡外の副作用が二重・三重に積もる（leak）。

### in-place auto-capture が成立しない（cross-agent review で検証済み）

「危険な global を init 実行中だけ wrap して記録・逆操作する」auto-capture 案は、両方向に壊れる：

- **downstream を誤捕捉**：`ctx.dispatchEffect` は `EffectDispatcher.dispatch` で同期に listener を回す（`src/core/space/effect-dispatcher.ts:23`）。`ctx.setActiveUi` は同期に UI pack の `mount()` を走らせる（`src/App.tsx:2358`、DOM append・listener 張りうる）。init.js が `ctx.setActiveUi(...)` を呼んだだけで UI pack の listener が捕捉対象に紛れ、次回 reload で**本体機能を removeEventListener** してしまう。「同期窓なら誤捕捉を避けられる」という防御は、誤捕捉が同期 fan-out で起きるため無効。
- **top-level を取りこぼす**：`import(?v=mtime)` は default 取得前に module top-level を評価するが、wrapper は default 直前に張る。`export default` の外の `window.addEventListener` はリロード毎 leak。弱い LLM（住人 AI が低精度モデルの可能性）は普通に top-level に書く。

修正（ctx.* 呼び出し中は capture を suspend）は、現在・将来の全同期 fan-out 経路を漏れなく suspend する whack-a-mole で、1 つ忘れれば本体が壊れる。[認知負荷 lens](cognitive-load-design-lens.md)（追跡 layer / 保持 state を増やすな）と「large-diff は質で代償を払う」に反する。init.js は編集頻度の低い boot config なので、手動 reload の摩擦は実質小さい。→ in-place の複雑さは割に合わない。

### 明示 reload 契約という選択

init.js は本質的に「何でもできる」層。pack と同じ hot reload 体験を急いで揃えるより、最初は Emacs `init.el` 的な「明示 reload 契約」にしておく方が安全で正直。Emacs 自身 init.el を hot reload しない（再起動 or 手動 eval、後者は同じ leak 問題を持つ）。

## 将来（v1 の scope 外）

- **次点：full-reload-on-save**（保存で `window.location.reload()`）。leak は確実に消えるが、AI 編集中の flash・64KB scrollback 切り詰め・re-mount、壊れた保存で init 無し状態に reboot、というコスト。やるなら最低限「reload 前に shape-validate」「debounce + cooldown + single-flight」。PTY/agent は reload を survive する（ring buffer 再接続、`src-tauri/src/sessions/pty_session.rs:137`）。
- **in-place** は「本当に必要になってから」上記欠陥（suspend-during-ctx / top-level / async default 契約 / transactional run / generation token）を正面から設計し直す。

## 関連

- 設計の全記録：internal design-record（非公開）`2026-05-31-init-js-hot-reload-design.md`
- 既存の hot reload（pack 側）：`src/runtime/user-pack-loader/watcher.ts`、internal design-record `2026-04-15-hot-reload-and-ugc-hot-swap.md`
- [cognitive-load-design-lens.md](cognitive-load-design-lens.md)
