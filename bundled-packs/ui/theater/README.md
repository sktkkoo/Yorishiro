# theater — character だけを全画面化する UI（bundled ui pack）

chrome と terminal を隠し、character だけを全画面に立たせるモード。作業面を完全に退け、住人だけが画面に在る状態をつくる。

## 開く動線

UI pack は single-active。theater が `activeUi` に選ばれると開き、別の UI pack に swap すると閉じる（直前 state の復元は settings pack 側の責務で、theater 自体は復元 logic を持たない）。activate 経路は以下：

- `~/.charminal/config.json` の `activeUi` を `"theater"` にする（user が explicit に picks する永続選択）
- init.js などから SDK の `setActiveUi("theater")` を呼ぶ自由経路
- 住人 AI が MCP tool `ui.activate`（`{ id: "theater" }`）で runtime のみ切替（config.json は触らない）

## 閉じる動線

theater は専用の閉じる button を持たない。`activeUi` を別 pack（例：default-shell / immersive / `null`）に swap すれば閉じる。同じ activate 経路（config.json / `setActiveUi` / `ui.activate`）で別 id を渡す。

## 主な挙動

`mount` は何も描画せず、`layout` 宣言だけで構成が完結する：

- `sidebar.width: "fullscreen"` — character のステージを全画面に広げる
- `terminal.position: "hidden"` — terminal を非表示にする
- `chrome.visible: false` — folder / gear 行を非表示
- `tabIndicator.visible: false` — terminal が見えずタブ切替が無意味なため、セッション切替の pill も隠す
- `transition.kind: "stage"` — chrome 行が上へ引っ込んでからステージが全画面へ開くアニメーション（閉じるときは逆順）

terminal を背後に残したまま透かす場合は immersive pack を使う。

## Fork

`~/.charminal/packs/theater/` 配下に同 id の pack を置けば、bundled を override する形で改変可能。`feedback_pack_override_pattern` 参照。

## 関連 doc

- UI pack 制度: `src/sdk/ui-pack.d.ts`、`docs/decisions/`
- Internal design-record: `specs/2026-05-18-shell-named-surfaces-design.md §5-P3`
