# clai-shared — CLAI persona の共通骨格（shared module）

`clai-en` / `clai-ja` の両 persona pack が import する **共通 factory module**。
それ自体は pack ではない（`manifest.json` を持たず、Charminal の pack 一覧には現れない）。

`createClaiPersona({ id, name, systemPromptAddition })` を export し、`id` / `name` /
言語別の system prompt overlay だけを引数で受け取って、残りの骨格——反射層の
trigger と reaction handler、世界の選択、ログ参照ポリシー——を共有する。
言語の違いは呼び出し側（`clai-en/persona.ts` / `clai-ja/persona.ts`）が
`persona.md?raw` で渡す system prompt と、それぞれの pack が継ぎ足す追加指示に閉じ、
身体表現のコードは一切重複させない。

## 共有される反射層

- **customTriggers**
  - `clai:error`: `post-tool-failure` hook を `distressed` に mapping。`Grep` / `Glob`
    の failure（no-match 等）は benign として抑止する。
  - `clai:git-push-success`: `post-tool-use` hook の bash tool response から push 成功を
    検知して `celebrate` を発火。
  - `clai:shortcut-shoot`: synthetic event `clai:shoot` を `mischievous-shoot-shortcut`
    に mapping（user が init.js のショートカットで明示発火する時だけ走る）。
  - `clai:settings-write-failed`: 設定 UI の recoverable write error の synthetic event を
    `settings-error` に mapping。

- **responses**: `distressed`（frown + screen-shake）、`settings-error`（shake なし frown）、
  `celebrate`（fireworks-volley + smile）、`pleased`、`startled`、`contemplative`、
  `acknowledging`、`mischievous-shoot-shortcut`（gun_fire motion と text-physics を
  timeline で同期）、`idle-fidget`（look-around / blink / subtle-stretch を weight で確率選択）。

- **world**: `vrm:default` / `voice:default` / `space:default`。
- **logReading**: session-boundary で own framing、windowSize 10 の内省型。

## 編集について

このファイルは **Charminal 本体の一部**。Charminal 内（AI / `/yori` / file writer）からは
編集不可で、本体の version up でのみ更新される（memory: `feedback_bundled_pack_immutability.md`）。
CLAI の挙動を自分用に変えたい場合は `clai-en` / `clai-ja` を `~/.charminal/packs/<id>/` に
fork する（factory を直接 import せず、必要な部分を自分の persona に書き写す）。

## 関連

- 参考実装としての位置づけ: `createClaiPersona` の docstring（「dry-run の pattern」「他の persona を書くときの参考実装」）
- Philosophy: `docs/philosophy/PHILOSOPHY.md`「意識に先立つ反応」
