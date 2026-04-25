# charminal-settings UI Pack

Charminal の設定画面。`activeUi` を `"charminal-settings"` に一時 swap することで開き、閉じる時に直前の `activeUi` を復元する。

## 開く動線

- chrome（`src/sidebar.tsx`）の歯車 icon button
- user が init.js で `setActiveUi("charminal-settings")` を呼ぶ自由経路

## 閉じる動線

設定画面右上の ✕ button。直前の `activeUi`（`ui-state-store` に保存）を `setActiveUi(...)` で復元する。

## 設定項目

- **キャラクター**: VRM body / Persona / Scene
- **ターミナル**: Coding agent (Claude / Codex)
- **ショートカット**: terminal に `/charminal:charm ショートカットを変更したい` を pre-fill する button
- フッタ: `⌘R / Ctrl+R` の hint

## Fork

`~/.charminal/packs/charminal-settings/` 配下に同 id の pack を置けば、bundled を override する形で改変可能。`feedback_pack_override_pattern` 参照。

## 関連 doc

- 設計仕様: `../Charminal-design-record/specs/2026-04-25-settings-screen-design.md`
- UI pack 制度: `docs/decisions/`、`src/sdk/ui-pack.d.ts`
