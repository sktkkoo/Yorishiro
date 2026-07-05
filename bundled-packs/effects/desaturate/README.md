# desaturate — 画面全体の grayscale 化（bundled effect pack）

画面全体に CSS `grayscale` filter を適用する bundled Effect Pack。`ctx.renderer.addCssFilter` で filter を追加し、`durationMs` 経過後に dispose する。idle 時やエラー時に彩度を落として「沈黙」「停滞」を視覚的に表現する用途。

## 使い方

**persona handler から**：`ctx.space.injectEffect` 経由。

```typescript
ctx.space.injectEffect({
  kind: "desaturate",
  durationMs: 3000,
  intensity: 0.8,
});
```

**`~/.yorishiro/init.js` から**：`ctx.dispatchEffect` 経由。

```javascript
ctx.dispatchEffect({
  kind: "desaturate",
  durationMs: 3000,
});
```

## options

| field | 型 | default | 意味 |
|---|---|---|---|
| `durationMs` | `number` | (必須) | filter を適用する時間（ms） |
| `intensity` | `number` | `1` | grayscale の強度。0（無効）〜 1（完全モノクロ） |

## 境界

- singleton: true。2 回連続で呼ばれたら前の実行を abort し、新しい dispatch だけが残る
- abort 時は即座に filter を解除する（画面が grayscale のまま残ることはない）
