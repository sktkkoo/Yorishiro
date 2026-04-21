# minimal-badge — Plan 1 の動作確認用 bundled UI pack

画面右上に半透明バッジを 1 つ表示するだけの最小 UI pack。クリックで screen-shake を発火する。

## 役割

Plan 1 の完了判定を実機で取るための dummy。「UI pack が mount されて、ctx を受け取り、container に描画されている」の ゲート条件を満たす。

## layout

`layout: {}` — Charminal 本体の layout は一切変更しない。

## mount

- React でバッジ component を render
- click で `ctx.space.injectEffect({ kind: "screen-shake" })`
- dispose で `root.unmount()`

Plan 2 以降では camera-lighting-panel など本格的な UI pack に置き換わる。
