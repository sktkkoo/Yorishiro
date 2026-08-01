# Agent State Expression

Realtime speech の spoken text と分離した、provider / avatar 非依存の状態表現 side channel。
新しい model call、inline tag、MCP 往復は使わない。

統合 API は `resolveAssistantTranscriptDelta()` と `StateExpressionScheduler` の二段。前者へ
assistant の `thread/realtime/transcript/delta` だけを渡し、後者の `startUtterance()` へ remote
audio の speech start と同じ clock を渡す。`onCue` が受け取るのは `agree` 等の semantic intent
であり、animation file 名への解決は既存 Body / Motion catalog adapter が所有する。

transcript が speech start より先に届く順序もあるため、最初の assistant delta で
`prepareUtterance()` を呼ぶ。start 前の `schedule()` は cue を queue し、正確な audio clock を
`startUtterance()` で渡した時点で相対時刻へ展開する。暫定 start 時刻を推測して後から rebase しない。

## Wiring

- `codex-realtime-client.ts` は assistant の transcript delta だけを controller へ渡す。done notification の
  full `text` は delta と重複するため再投入しない。
- stable item ID は upstream contract に無いため、client 内連番を `utteranceId` に使う。
- Body が lip-sync をsampleする同じrender clockからremote speech start/endを検出し、schedulerへ渡す。
- expression は `speech` source の専用 mood slot、gesture は `speech-expression` motion laneへ解決する。
  `neutral` はpresetをacquireせず、adapterが所有するslotだけをreleaseする。
- user transcriptによるbarge-in、voice stop、disconnect、session切替は未発火cueと所有handleを解放する。

## 実機調整 TODO

1. transcript delta と audio の到着差を記録する。現 core の `atMs` は固定話速の推定なので、
   長い発話で誤差が累積する場合は inline tag や word alignment を仮定せず、speech activity / cue 到着時刻で
   節単位に再 anchor する adapter を比較する。
2. `agree` / `consider` / `reassure` / `emphasize` のVRMA mappingとweightをpersonaごとに調整できるcatalogへ
   移す。現状はbundled animationの安全な小動作へhost側で固定mappingしている。
