# 音声はテキスト出力と分離し、明示的な tool call で発声する

> このファイルは「**住人の音声出力（TTS）をどう設計するか**」を決めたときに読む。対象：dev / AI / pack 作者。

**Status**: active（2026-05-10 採用）
**Last updated**: 2026-05-10

## TL;DR

住人 AI の音声出力は LLM のテキスト出力と独立した経路（MCP `voice.say` tool / SDK `ctx.voice.say()`）で制御する。全テキストを自動読み上げするのではなく、住人が「声に出す価値がある」と判断したセリフだけを明示的に発声する。

---

## 何を決めたか

### 採用

- LLM のテキスト出力を自動的に TTS に流さない
- 住人 AI が MCP tool `voice.say` を明示的に呼ぶことで発声する
- persona pack の reflex handler は SDK `ctx.voice.say()` を明示的に呼ぶことで発声する
- 両経路は同じ VoicePlayer を経由する（symmetry principle）

### 不採用

- LLM 出力の全文読み上げ（どこがセリフでどこがツール使用かを分離できない）
- マーカー方式（`<say>text</say>` のようなタグで LLM 出力内のセリフ箇所を指定する）
- ヒューリスティック解析（LLM 出力からセリフ部分を推定する）

## なぜそうしたか

1. **分離の困難**: LLM の出力にはセリフ・コード説明・ツール使用結果などが混在する。テキストレベルでセリフを切り出す信頼性の高い方法がない
2. **明示性**: Yorishiro は "explicit over implicit" の原則を持つ。音声出力も住人の意思による明示的な行為であるべき
3. **邪魔しない**: 全文読み上げは user の作業を妨害する。必要なセリフだけ声にすることで autonomy-without-disruption 原則と合致する
4. **制御可能性**: tool call なので voice / volume / speed を発声ごとに制御できる

## 実装の所在

- Rust TTS: `src-tauri/src/tts.rs`（macOS `say` / Windows PowerShell / 他 no-op）
- TS VoicePlayer: `src/core/voice/voice-player.ts`
- SDK surface: `src/sdk/context.d.ts` の `VoiceAPI`
- MCP tool: `src-tauri/src/mcp/tools.rs` の `voice_say`
- TS handler: `src/runtime/yorishiro-mcp/tool-handlers.ts` の `createVoiceSayHandler`
