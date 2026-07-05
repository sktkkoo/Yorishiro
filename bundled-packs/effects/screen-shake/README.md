# screen-shake — 画面全体を短く揺らす（bundled effect pack）

画面全体（terminal + character canvas）を短く揺らす bundled Effect Pack。
主用途は error 時の DOM shake。実装は `ctx.renderer.addShakeFilter` のみ使う薄い
wrapper で、decay profile（揺れの減衰カーブ）は Renderer 実装側が持ち、pack は
`ctx.time.after` で lifetime を管理するだけ。

## 使い方

**persona handler から**：`ctx.space.injectEffect` 経由。

```typescript
ctx.space.injectEffect({
  kind: "screen-shake",
  intensity: 1.5,
  durationMs: 400,
});
```

**`~/.yorishiro/init.js` から**：`ctx.dispatchEffect` 経由（`YorishiroInitContext` は `space` API を持たないため）。

```javascript
ctx.dispatchEffect({
  kind: "screen-shake",
  intensity: 1.5,
  durationMs: 400,
});
```

## options

すべて optional。

| field | 型 | default | 意味 |
|---|---|---|---|
| `intensity` | `number` | `1` | 揺れの強さ。`addShakeFilter` にそのまま渡す |
| `durationMs` | `number` | `300` | shake filter を保持する時間（ms） |

## 境界

- 揺れの decay profile（時間に対する減衰）は pack ではなく Renderer の
  `addShakeFilter` 実装が所有する。pack 側は `intensity` と lifetime のみを扱う。
- 短命 effect 専任。`durationMs` 経過後（or 中断時）に shake filter は `dispose` される。
