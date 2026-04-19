# fireworks — 1 burst の花火（bundled effect pack）

指定 `origin` から 1 回だけ花火を emit する bundled Effect Pack。`ctx.renderer.drawOnCanvas`
で overlay canvas を確保し、particle を `requestAnimationFrame` loop で animate、
`durationMs` 経過後に canvas を dispose する。

## 使い方

**persona handler から**：`ctx.space.injectEffect` 経由。

```typescript
ctx.space.injectEffect({
  kind: "fireworks",
  origin: { x: 0.5, y: 0.3 },
  count: 90,
  durationMs: 1800,
});
```

**`~/.charminal/init.js` から**：`ctx.dispatchEffect` 経由（`CharminalInitContext` は `space` API を持たないため）。

```javascript
ctx.dispatchEffect({
  kind: "fireworks",
  origin: { x: 0.5, y: 0.3 },
  count: 90,
  durationMs: 1800,
});
```

## options

| field | 型 | 意味 |
|---|---|---|
| `origin` | `Vec2` | 粒の emit 起点。正規化座標 (0-1) |
| `count` | `number` | 粒の数 |
| `durationMs` | `number` | canvas を保持する時間 |

各粒の hue は生成時に `Math.random` で決まる。色指定の option は持たない
（将来 `hue?` を非破壊追加する余地あり）。

## 境界

- この pack は **1 burst 専任**。連発（3 発同時打ち上げなど）は呼び出し側
  （persona / init.js）が `injectEffect` を複数回 `setTimeout` で刻むこと。
- window resize には追従しない（短命 effect 前提、canvas は `drawOnCanvas`
  呼び出し時の window size で固定）。
