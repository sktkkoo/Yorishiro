# screen-flash — 画面全体を白く一瞬フラッシュさせる（bundled effect pack）

画面全体を一瞬だけフラッシュさせる bundled Effect Pack。`ctx.renderer.addDomLayer`
で全画面の DOM overlay を貼り、opacity を CSS transition で animate する。短い
fade-in → peak → afterglow（残像）→ 0 の順で減衰し、邪魔にならない肌触りを狙う。
主用途は screenshot 撮影時の視覚フィードバック（カメラの shutter flash 風）。

DOM overlay であって Three.js scene 内ではないため、撮影直後の screenshot 自体には
flash 像は写らない（撮影 → 結果返却 → micro-task で flash dispatch の順序）。

## 使い方

**persona handler から**：`ctx.space.injectEffect` 経由。

```typescript
ctx.space.injectEffect({
  kind: "screen-flash",
  peakOpacity: 0.8,
  fadeOutMs: 120,
});
```

**`~/.charminal/init.js` から**：`ctx.dispatchEffect` 経由（`CharminalInitContext` は `space` API を持たないため）。

```javascript
ctx.dispatchEffect({
  kind: "screen-flash",
  peakOpacity: 0.8,
  fadeOutMs: 120,
});
```

## options

すべて optional。

| field | 型 | default | 意味 |
|---|---|---|---|
| `color` | `string` | `"#ffffff"` | flash の色（CSS color） |
| `fadeInMs` | `number` | `25` | fade-in にかける時間（ms）。最低 1 |
| `fadeOutMs` | `number` | `110` | peak → afterglow への drop 時間（ms）。最低 1 |
| `peakOpacity` | `number` | `0.85` | peak opacity (0-1) |
| `afterglowOpacity` | `number` | `0.12` | afterglow（残像）の opacity (0-1)。0 で残像なし |
| `afterglowFadeMs` | `number` | `850` | afterglow が 0 まで完全に消えるまでの時間（ms） |

## 境界

- DOM overlay (`z-index: 9999`, `pointer-events: none`) であり、Three.js scene 内の
  描画ではない。screenshot には写らない（上記の dispatch 順序が前提）。
- 短命 effect 専任。run 終了時（afterglow 完了 or 中断）に overlay layer は
  `dispose` される。
