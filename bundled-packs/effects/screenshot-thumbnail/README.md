# screenshot-thumbnail — 撮影した screenshot を右下サムネイル表示する（bundled effect pack）

撮影済み screenshot の `dataUrl` を受け取り、`ctx.renderer.addDomLayer` で全画面の
DOM overlay として貼る bundled Effect Pack。次フレームで transform の
translate + scale のみを使って右下へ縮小し、縮小中に border-radius / box-shadow /
枠を fade-in してカード化する。主用途は MCP screenshot 撮影時の視覚フィードバック。

DOM overlay であって Three.js scene 内ではないため、撮影直後の screenshot 自体には
サムネイル像は写らない（撮影 → dataUrl / PNG bytes 確定 → dispatch の順序）。
表示中に次の screenshot が来た場合は、古い layer を即 dispose して最新画像に置換する。

## 使い方

**persona handler から**：`ctx.space.injectEffect` 経由。

```typescript
ctx.space.injectEffect({
  kind: "screenshot-thumbnail",
  dataUrl: "data:image/png;base64,...",
});
```

**`~/.yorishiro/init.js` から**：`ctx.dispatchEffect` 経由（`YorishiroInitContext` は `space` API を持たないため）。

```javascript
ctx.dispatchEffect({
  kind: "screenshot-thumbnail",
  dataUrl: "data:image/png;base64,...",
});
```

## options

`dataUrl` のみ必須。その他は optional。

| field | 型 | default | 意味 |
|---|---|---|---|
| `dataUrl` | `string` | なし | 表示する screenshot の data URL |
| `shrinkMs` | `number` | `460` | 全面画像からサムネイルへ縮小する時間（ms）。最低 1 |
| `holdMs` | `number` | `2600` | サムネイル状態で保持する時間（ms）。0 以上 |
| `fadeOutMs` | `number` | `360` | 退場 fade-out の時間（ms）。最低 1 |
| `thumbnailWidth` | `number` | `240` | サムネイルの目標幅（CSS px）。最低 1 |
| `margin` | `number` | `22` | 右下からの余白（CSS px）。0 以上 |
| `easing` | `string` | `"cubic-bezier(0.22, 1, 0.36, 1)"` | 縮小 transform の easing |

## 境界

- DOM overlay (`pointer-events: none`) であり、Three.js scene 内の描画ではない。
  screenshot には写らない（上記の dispatch 順序が前提）。
- 短命 effect 専任。run 終了時（fade-out 完了 or 中断）に overlay layer は
  `dispose` される。
- 表示中に次の dispatch が来た場合は、古い layer を即 dispose して置換する。
