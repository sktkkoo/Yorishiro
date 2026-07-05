# text-physics — ターミナル文字の重力落下 + 復元（bundled effect pack）

ターミナルの visible cells を overlay 上に複製し、重力落下 → バウンド → 元位置への吸い込み復元を行う bundled Effect Pack。`ctx.renderer.addDomLayer` で DOM overlay を確保し、各文字を `<span>` として物理アニメーションする。

## 使い方

**persona handler から**：`ctx.space.injectEffect` 経由。

```typescript
ctx.space.injectEffect({
  kind: "text-physics",
  origin: { x: 0.5, y: 0.8 },
  force: 100,
});
```

**`~/.yorishiro/init.js` から**：`ctx.dispatchEffect` 経由。

```javascript
ctx.dispatchEffect({
  kind: "text-physics",
  origin: { x: 0.5, y: 0.8 },
  force: 100,
  gravity: 800,
});
```

## options

| field | 型 | default | 意味 |
|---|---|---|---|
| `origin` | `Vec2` | (必須) | 効果の起点。正規化座標 (0-1)。`origin.y` 付近の行が affected 対象 |
| `force` | `number` | (必須) | 初速の強さ（水平方向の散らばり具合に影響） |
| `gravity` | `number` | `600` | 重力加速度 (px/s^2) |

## アニメーション phase

1. **hold** (200ms): 文字を元位置に静止表示
2. **cascade**: V 字パターンの遅延で各文字が重力落下 + 回転 + バウンド
3. **rest** (1000ms): 底面で静止
4. **restore** (600ms): ease-out cubic で元位置に復元

## 境界

- `queryTerminalCells()` が `null` を返す環境（test 環境等）では何もせず return
- affected 対象は `origin.y` 付近の 10 行。行数は内部定数で固定
- window resize には追従しない（短命 effect 前提）
