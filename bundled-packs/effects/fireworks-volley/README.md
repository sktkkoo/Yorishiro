# fireworks-volley — 連発花火（bundled effect pack）

指定 `count` 発の花火を時差で打ち上げる bundled Effect Pack。内部で `fireworks` pack を複数回呼び、各発の発射位置を `originRange` 内で random に散らす + 発射間隔に jitter を入れる。

`fireworks` pack が「1 burst 専任」の境界を持っているので、連発 / 位置散らし / 間隔 jitter は本 pack に切り出してある（[feedback_separate_conceptually_distinct_systems](../../../docs/decisions/separate-distinct-systems.md)：動き方が違うものは統合しない）。

## 使い方

**`~/.charminal/init.js` から**：

```javascript
ctx.dispatchEffect({ kind: "fireworks-volley" });
// または option を明示
ctx.dispatchEffect({
  kind: "fireworks-volley",
  count: 5,
  originRange: { x: [0.2, 0.8], y: [0.2, 0.45] },
});
```

**persona handler から**：`ctx.space.injectEffect` 経由、option は同じ。

## options（すべて optional）

| field | 型 | default | 意味 |
|---|---|---|---|
| `count` | `number` | `3` | 打ち上げ本数 |
| `originRange` | `{ x: [number, number]; y: [number, number] }` | `x: [0.15, 0.85]`, `y: [0.2, 0.45]` | 発射位置の random 範囲（正規化座標） |
| `delayStepMs` | `number` | `280` | 発射間隔の base（ms） |
| `delayJitterMs` | `number` | `120` | 発射間隔の jitter ±（ms） |
| `burstCount` | `number` | `50` | 各発の粒数（`fireworks` pack の `count`） |
| `burstDurationMs` | `number` | `2400` | 各発の `durationMs` hint（pack 側で必要なら延長） |

## 境界

- 1 発だけ上げたいなら `fireworks` を直接叩くこと（volley は連発専任）
- abort されたら volley pack は待機中の `setTimeout` を clear せず、各 burst が自分の signal 確認で早期 return する（発射済みの burst は自然 fade）
- 同時に重ねたい burst は別 `fireworks-volley` dispatch で。本 pack は 1 volley 内の時差を制御する
