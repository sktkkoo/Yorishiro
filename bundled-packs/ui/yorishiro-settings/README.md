# yorishiro-settings UI Pack

Yorishiro の設定画面。`activeUi` を `"yorishiro-settings"` に一時 swap することで開き、閉じる時に直前の `activeUi` を復元する。

## 開く動線

- chrome（`src/sidebar.tsx`）の歯車 icon button
- user が init.js で `setActiveUi("yorishiro-settings")` を呼ぶ自由経路

## 閉じる動線

設定画面右上の ✕ button。直前の `activeUi`（`ui-state-store` に保存）を `setActiveUi(...)` で復元する。

## 設定項目

- **キャラクター**: VRM body / Persona / Scene。VRM は独立した chooser で検索・サムネイル・作者・利用条件を確認し、固定 footer の明示的な「切り替える」でだけ変更する。import は候補追加までで即時適用しない。選択中でない imported VRM は確認後に一覧から外して AppData の管理用コピーを削除できるが、読み込み元の VRM file には触れない。存在しない active path は通知後に自動整理する
- **ターミナル**: Coding agent（Claude Code / Codex）。OpenCode adapter は内部に残すが、dropdown には表示しない
- **ショートカット**: terminal に選択中 agent 用の固定 shortcut prompt（Claude Code は `/yori:shortcut ...`、Codex は `$yori-shortcut ...`、OpenCode は `/yori-shortcut ...`）を pre-fill する button
- フッタ: `⌘R / Ctrl+R` の hint

## Fork

`~/.yorishiro/packs/yorishiro-settings/` 配下に同 id の pack を置けば、bundled を override する形で改変可能。ただし id は capability token ではなく、user fork は bundled source の system authority を継承しない。通常 UI Pack と同じく supported authoring surface は `@yorishiro/sdk` と明示された host shim に限られる。`docs/decisions/pack-override-pattern.md` と `docs/decisions/system-settings-privileged-boundary.md` を参照。

## Known limitations (user fork)

このバージョンは app と同じ release/review 単位の system-owned bundled UI として動く。`~/.yorishiro/packs/` に置く user fork で完全再現する契約ではない。

汎用性と安全性が明白な機能は public capability を使う：

- ショートカット pre-fill は `ctx.app.insertFixedPrompt("shortcut")`（host 所有の固定プロンプトを key で指す SDK verb）経由。pack は文字列を渡さず、`src/bindings/tauri-commands` の直 import は持たない。任意テキストを terminal に書く API は意図的に存在しない（設計境界: `docs/decisions/input-prefill-boundary.md`）
- app version は `ctx.app.getVersion()`、HTTPS link は `ctx.app.openExternal()`、snapshot 操作は確認 component と destructive command を host が所有する `ctx.history` を使う

一方、以下は監査済み bundled exception のまま残す：

- VRM catalog / bounded thumbnail / file picker / confirmed removal (`list_vrm_avatars` + `read_vrm_thumbnail` + `@tauri-apps/plugin-dialog` + `import_vrm` + `remove_vrm_avatar`)
- `localStorage["yorishiro:vrm"]` の magic string を直接読んでいる
- updater / process relaunch、app 固有 i18n、snapshot 表示 helper、language/config policy helper、bundled default scene manifest

これらを user Pack に公開するには permission declaration、host-side gate、approval UX の設計が必要。今回 raw Tauri passthrough は追加しない。terminal 入力については `insertFixedPrompt` の固定 key 集合が SDK 公開面であり、任意書き込み口は追加しない方針（`input-prefill-boundary.md`）。

## 関連 doc

- 設計仕様: `../Yorishiro-design-record/specs/2026-04-25-settings-screen-design.md`
- UI pack 制度: `docs/decisions/`、`src/sdk/ui-pack.d.ts`
