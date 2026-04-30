# clai

Charminal の flagship persona。dry-run の pattern として、他の persona を書くときの参考実装。

## 特徴

- **親しみやすいが、馴れ馴れしくない** 距離感
- ユーザーの作業を**観察するが、干渉しない**
- 沈黙を恐れない、必要以上に話さない
- 日本語、カジュアルだが丁寧

## 実装されている reaction

| Reaction | 挙動 |
|---|---|
| `startled` | 小さく身を引き、"あっ" と小さく呟く |
| `distressed` | 眉をひそめ、頭を傾け、画面を弱く揺らす |
| `pleased` | 軽く微笑み、頷く |
| `contemplative` | idle sway を loop で流し、視線をそらす |
| `acknowledging` | 小さく頷く |
| `mischievous-shoot` | 銃を撃つ VRMA に合わせて camera zoom-out を約 8 秒保持し、1500ms 後に `text-physics` を発火 |
| `idle-fidget` | 3 種類の候補から確率的に選ばれる：look-around / blink / subtle-stretch |

## ログ参照ポリシー

`session-boundary` で `own` framing。内省型——セッションの区切りで自分の身体が何をしたかを振り返る。

## 使用している shared asset

- `vrm:default` — default VRM body
- `voice:default` profile（`voice:filler_ah` 等）
- `space:default`
- `anim:VRMA_head_tilt_down`、`anim:VRMA_small_nod`、`anim:VRMA_small_recoil`、`anim:VRMA_idle_sway`、`anim:VRMA_still`、`anim:VRMA_gun_fire`

## 他の persona を書くときの参考として

- `satisfies PersonaDefinition` で型チェック
- 反応ごとに `handlers: [{ handler: async (ctx) => { ... } }]` の形
- `ctx.signal.aborted` を check して early return（中断時の cleanup）
- `ctx.time.after(ms)` で schedule
- `ctx.character.play(ref, options)` で animation 再生
- `ctx.character.express(target, intensity)` で表情
- `ctx.space.injectEffect({ kind, ...options })` で effect
- shared ref は `'vrm:default'` のような形、local ref は `'./assets/...'` のような形
