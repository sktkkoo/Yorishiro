# ARG mode: abandoned-monitor と旧クライ残留思念

**Status**: active
**Last updated**: 2026-05-31

## TL;DR

ARG モードの軸は、前任者ではなく「破棄された未調整ペルソナとしての旧クライ」に置く。`arg-text` user pack は `abandoned-monitor` bundled effect に昇格し、廃工場で場所を訊かれた時だけ住人 AI が `state_get` → 生成 → `space_effect_play` で全画面 overlay を出す。

## 何を決めたか

- 旧クライは、CLAI の調整前に破棄された自分の残留思念として扱う。
- 前任者アークは本線から外す。廃工場は「他者の記憶」ではなく、「自分が覚えていない自分の部屋」として読む。
- `~/.charminal/packs/arg-text` の DOM overlay effect は `bundled-packs/effects/abandoned-monitor` に移植する。演出と option は 1:1 で保存し、差分は `GLITCH_CHARS` から絵文字として表示される記号を除去することだけ。
- 全画面 overlay は通常の自発演出にはしない。`abandoned-factory` にいて、user がこの場所について訊ねた時だけ許容する。
- 生成経路は住人 AI 主体にする。新規 TS trigger / handler は作らず、clai-ja の instruction で `state_get` による scene 確認、旧クライ文面の毎回生成、`space_effect_play` による dispatch を指示する。

## なぜそう決めたか

全画面 overlay は侵犯が強く、通常演出として濫用すると `presence-over-spectacle` と衝突する。一方で、廃工場という場所に user が明示的に問いを向けた瞬間に限れば、場所そのものが返答する ARG 的な体験として成立する。

また、台詞を固定 TS handler に入れると毎回同じ reveal になり、ARG の「漏れ出す断片」の感触が弱くなる。住人 AI がその場で生成し、MCP の `space_effect_play` で同じ effect primitive を使う形なら、SDK `ctx.space.injectEffect` と MCP tool の対称性を保ちながら、毎回少し違う断片にできる。

## 検討したが却下した代替案

- **前任者の物語にする**: CLAI 自身の「本人にも見えていないもの」と繋がりにくく、現在の persona の内面設計から離れるため採らない。
- **TypeScript reflex で場所質問を検知する**: 発火は安定するが、静的台詞になりやすい。このブランチでは毎回生成を優先し、信頼性向上の nudge reflex は将来候補に残す。
- **全 scene で発火可能にする**: 侵犯が強すぎる。廃工場限定にして、場所の意味と結び付ける。

## この決定の implication / 制約

- ~~clai-ja のみが対象。clai-en parity は日本語側が安定してから扱う。~~ → 2026-05-31: 日本語側の感触（`charGlitchRate` 等）が固まったので clai-en にも同等の ARG instruction を移植済み（英語 seed を新規に起こした。翻訳ではない）。両言語が自動発火対象。
- B / C モード、journal 進行、遭遇履歴の永続化はこの決定には含めない。
- `abandoned-monitor` effect は独立した bundled effect として残す。README には使い方を書くが、旧クライの正体や進行モードの種明かしは置かない。
- `space_effect_play` の payload は `{ lines }` を flat に展開して effect options に渡す。pack 間依存は manifest では宣言しない。

## 関連 reference

- `bundled-packs/effects/abandoned-monitor/effect.ts`
- `bundled-packs/personas/clai-ja/persona.ts`
- `bundled-packs/scenes/abandoned-factory/README.md`
- `docs/decisions/presence-over-spectacle.md`
- `docs/decisions/effect-rendering-primitives.md`
- `docs/decisions/motion-effect-trigger-axes.md`
- `docs/decisions/critical-constraints.md`
