# immersive — ターミナル背景を透かし character/scene を前面に通す没入 UI（bundled ui pack）

terminal を全画面前面に置きつつ、その背景だけを透明化することで、背後の character と scene が鮮明に透けて見える没入モード。文字は前景色で不透明のまま読めるので、terminal 出力を判読しながら character + scene をバックドロップとして同時に味わえる。

## 開く動線

UI pack は single-active。immersive が `activeUi` に選ばれると開き、別の UI pack に swap すると閉じる（直前 state の復元は settings pack 側の責務で、immersive 自体は復元 logic を持たない）。activate 経路は以下：

- `~/.yorishiro/config.json` の `activeUi` を `"immersive"` にする（user が explicit に picks する永続選択）
- init.js などから SDK の `setActiveUi("immersive")` を呼ぶ自由経路
- 住人 AI が MCP tool `ui.activate`（`{ id: "immersive" }`）で runtime のみ切替（config.json は触らない）

## 閉じる動線

immersive は専用の閉じる button を持たない。`activeUi` を別 pack（例：default-shell / theater / `null`）に swap すれば閉じる。同じ activate 経路（config.json / `setActiveUi` / `ui.activate`）で別 id を渡す。

## 主な挙動

`mount` は何も描画せず、`layout` 宣言だけで構成が完結する：

- `sidebar.width: "fullscreen"` — shell-column（character + scene）を全画面バックドロップに広げる。`overlay` / `transparent` は使わない（scene を不透明に描画してバックドロップとして見せたいため）
- `terminal.position: { top/left: 0, width: 100vw, height: 100vh }` + `transparentBackground: true` — terminal を全画面固定配置し、背景のみ透明化（element opacity 版から移行、文字は不透明のまま）
- `chrome.visible: false` — folder / gear 行を非表示
- scene の `updateLayer` / `resetAll` は呼ばない（scene を抑制せずバックドロップとして活かす）

terminal を完全に消したい場合は theater pack を使う。

## Fork

`~/.yorishiro/packs/immersive/` 配下に同 id の pack を置けば、bundled を override する形で改変可能。`feedback_pack_override_pattern` 参照。

## 関連 doc

- UI pack 制度: `src/sdk/ui-pack.d.ts`、`docs/decisions/`
- Internal design-record: `specs/2026-05-18-shell-named-surfaces-design.md §5-P3`
