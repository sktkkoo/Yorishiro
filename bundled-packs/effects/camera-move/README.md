# camera-move — カメラワーク（bundled effect pack）

Three.js camera を一時的に動かして、完了後に元の状態へ戻す bundled Effect Pack。`ctx.renderer.addCameraMove` を使うため、camera tracking は実行中だけ claim される。

## 使い方

```typescript
ctx.space.injectEffect({
  kind: "camera-move",
  offset: { z: 0.3 },
  fovOffset: 3,
  durationMs: 180,
  holdMs: 260,
  restoreMs: 620,
});
```

## options

| field | 型 | default | 意味 |
|---|---|---|---|
| `offset` | `Partial<Vec3>` | `{ z: 0.28 }` | 現在位置からの相対移動量。`z` 正方向で zoom out |
| `fovOffset` | `number` | `3` | 現在 FOV からの相対変化量。正方向で広角化 |
| `durationMs` | `number` | `180` | target へ移動する時間 |
| `holdMs` | `number` | `260` | target 位置で保持する時間 |
| `restoreMs` | `number` | `620` | 元の camera state へ戻す時間 |
| `lookAt` | `Vec3` | runtime default | 各 frame で注視する点 |

## 境界

- singleton: true。連続 dispatch では前の camera move を abort してから新しい move を開始する
- scene pack の background / foreground DOM layer には触らない
