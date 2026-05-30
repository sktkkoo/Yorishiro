# charminal-settings UI Pack

Charminal の設定画面。`activeUi` を `"charminal-settings"` に一時 swap することで開き、閉じる時に直前の `activeUi` を復元する。

## 開く動線

- chrome（`src/sidebar.tsx`）の歯車 icon button
- user が init.js で `setActiveUi("charminal-settings")` を呼ぶ自由経路

## 閉じる動線

設定画面右上の ✕ button。直前の `activeUi`（`ui-state-store` に保存）を `setActiveUi(...)` で復元する。

## 設定項目

- **キャラクター**: VRM body / Persona / Scene
- **ターミナル**: Coding agent (Claude / Codex（実験的）/ OpenCode（実験的）)。dropdown では Claude 以外に「（実験的）」suffix を付ける（`localizedAgentOptions` / `EXPERIMENTAL_AGENT_IDS`）
- **ショートカット**: terminal に選択中 agent 用の固定 shortcut prompt（Claude Code は `/charm:shortcut ...`、Codex は `$charm-shortcut ...`、OpenCode は `/charm-shortcut ...`）を pre-fill する button
- フッタ: `⌘R / Ctrl+R` の hint

## Fork

`~/.charminal/packs/charminal-settings/` 配下に同 id の pack を置けば、bundled を override する形で改変可能。`feedback_pack_override_pattern` 参照。

## Known limitations (user fork)

このバージョンは bundled として動くことを前提に書かれており、`~/.charminal/packs/` に置く user fork で完全再現するには SDK 拡張が必要です。具体的には：

- ショートカット pre-fill は `ctx.app.insertFixedPrompt("shortcut")`（host 所有の固定プロンプトを key で指す SDK verb）経由。pack は文字列を渡さず、`src/bindings/tauri-commands` の直 import は持たない。任意テキストを terminal に書く API は意図的に存在しない（設計境界: `docs/decisions/input-prefill-boundary.md`）
- VRM file picker (`@tauri-apps/plugin-dialog` + `import_vrm`) を bundled で直接呼んでいる
- `localStorage["charminal:vrm"]` の magic string を直接読んでいる

VRM picker / localStorage 系は将来 SDK 側で `UiAppAPI.pickVrm()`, `getVrm()` を追加することで user fork でも完全再現可能になります（spec § 8 の将来課題参照）。terminal 入力については `insertFixedPrompt` の固定 key 集合が SDK 公開面であり、任意書き込み口は追加しない方針（`input-prefill-boundary.md`）。

## 関連 doc

- 設計仕様: `../Charminal-design-record/specs/2026-04-25-settings-screen-design.md`
- UI pack 制度: `docs/decisions/`、`src/sdk/ui-pack.d.ts`
