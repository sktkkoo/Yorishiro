# Agent State Expression

Realtime speech の spoken text と分離した、provider / avatar 非依存の状態表現 side channel。
新しい model call、inline tag、MCP 往復は使わない。

統合 API は `resolveAssistantTranscriptDelta()` と `StateExpressionScheduler` の二段。前者へ
assistant の `thread/realtime/transcript/delta` だけを渡し、後者の `startUtterance()` へ remote
audio の speech start と同じ clock を渡す。`onCue` が受け取るのは `acknowledging` や
`concerned` 等の grounded state と semantic body intent であり、animation file 名への解決は
既存 Body / Motion catalog adapter が所有する。

transcript が speech start より先に届く順序もあるため、最初の assistant delta で
`prepareUtterance()` を呼ぶ。start 前の `schedule()` は cue を queue し、正確な audio clock を
`startUtterance()` で渡した時点で相対時刻へ展開する。暫定 start 時刻を推測して後から rebase しない。

## Wiring

- `codex-realtime-client.ts` は assistant の transcript delta だけを controller へ渡す。done notification の
  full `text` は delta と重複するため再投入しない。
- stable item ID は upstream contract に無いため、client 内連番を `utteranceId` に使う。
- realtime client 所有のaudio sampling loopからremote speech start/endを検出し、schedulerへ渡す。
  Bodyのrenderやdocument visibilityから独立してlifecycleを完了できる。
- expression は既存`SpeechMoodChannel`から`ExpressionManager`の低優先度`speech` mood slotへ流し、
  persona / MCP / reflexの所有権を上書きしない。gestureは`MotionScheduler`の`speech-expression`
  laneへ解決し、procedural motionとはVRMA weightで相補blendする。
- grounded stateが続く間は既存`SpeechMicroexpressionSystem`の弱いbrow / eye / blink profileだけを
  調整する。`neutral` stateでもこのorganic variationは残すが、新しい感情categoryは生成しない。
- speech mood中は既存idle squint / idle microをsuspendし、lip syncとreflex blinkは独立channelで維持する。
- user transcriptによるbarge-in、voice stop、disconnect、session切替は未発火cueと所有handleを解放する。

## 実機調整 TODO

1. transcript delta と audio の到着差を記録する。現 core の `atMs` は固定話速の推定なので、
   長い発話で誤差が累積する場合は inline tag や word alignment を仮定せず、speech activity / cue 到着時刻で
   節単位に再 anchor する adapter を比較する。
2. `agree` / `consider` / `reassure` / `emphasize` のVRMA mappingとweightをpersonaごとに調整できるcatalogへ
   移す。現状はbundled animationの安全な小動作へhost側で固定mappingしている。
