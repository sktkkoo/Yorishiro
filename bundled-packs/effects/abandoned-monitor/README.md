# abandoned-monitor — 放置された監視端末風 ARG overlay（bundled effect pack）

破損したシステムログや暗号めいたメッセージを、タイプライター + グリッチ演出で全画面に表示する bundled Effect Pack。`ctx.renderer.addDomLayer` で DOM overlay を確保し、背景、スキャンライン、文字単位の揺らぎを重ねる。

`abandoned-factory` でこの場所について訊ねると、環境のノイズとしてこの overlay が立ち上がることがある。

## 使い方

**persona handler から**：`ctx.space.injectEffect` 経由。

```typescript
ctx.space.injectEffect({
  kind: "abandoned-monitor",
  lines: [
    "> CHANNEL OPEN",
    "...signal weak.",
    "> CHANNEL CLOSED",
  ],
});
```

**`~/.charminal/init.js` から**：`ctx.dispatchEffect` 経由。

```javascript
ctx.dispatchEffect({
  kind: "abandoned-monitor",
  lines: ["> MONITOR WAKE", "...no input."],
  durationMs: 8000,
});
```

**MCP から**：`space_effect_play` 経由。`payload.lines` は effect options に展開される。

```json
{
  "kind": "abandoned-monitor",
  "payload": {
    "lines": ["> SIGNAL", "...fragment lost."]
  }
}
```

## options

| field | 型 | default | 意味 |
|---|---|---|---|
| `lines` | `string[]` | 組み込みログ | 表示するテキスト行 |
| `durationMs` | `number` | `12000` | overlay 全体の持続時間（ms） |
| `color` | `string` | `"#00ff41"` | テキスト色 |
| `bgColor` | `string` | `"rgba(0, 0, 0, 0.85)"` | 背景色 |
| `typeSpeed` | `number` | `35` | 1 文字あたりのタイプ速度（ms） |
| `glitchIntensity` | `number` | `1` | 揺れの強さ（位置オフセット・画面ジッターの量）。0 で無効、1 が既定 |
| `charGlitchRate` | `number` | `1` | 文字が別の字に化ける頻度だけを独立に絞るノブ（0〜1）。`glitchIntensity` で揺れは保ったまま、これを下げると文面が読みやすくなる |
| `fontSize` | `number` | `16` | フォントサイズ（px） |

## 境界

- singleton: true。2 回連続で呼ばれたら前の実行を abort し、新しい dispatch だけが残る
- abort 時は RAF を止め、DOM layer を即座に dispose する
- グリッチ復元用の短い `setTimeout` は cancel せず、`AbortSignal` で安全側にガードする
