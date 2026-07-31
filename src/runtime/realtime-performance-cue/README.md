# Realtime performance cue core

Realtime Voice の spoken text と分離した、avatar 非依存の演技 side channel。新しい model call、
inline tag、MCP 往復は使わない。

統合 API は `resolveAssistantTranscriptDelta()` と `PerformanceCueScheduler` の二段。前者へ
assistant の `thread/realtime/transcript/delta` だけを渡し、後者の `startUtterance()` へ remote
audio の speech start と同じ clock を渡す。`onCue` が受け取るのは `agree` 等の semantic intent
であり、animation file 名への解決は既存 Body / Motion catalog adapter が所有する。

transcript が speech start より先に届く順序もあるため、最初の assistant delta で
`prepareUtterance()` を呼ぶ。start 前の `schedule()` は cue を queue し、正確な audio clock を
`startUtterance()` で渡した時点で相対時刻へ展開する。暫定 start 時刻を推測して後から rebase しない。

## Wiring TODO

PR #77 の review 修正との競合を避けるため、今回は wiring しない。

1. `codex-realtime-client.ts` で assistant transcript delta を `resolveAssistantTranscriptDelta()`、
   done を `finishAssistantTranscript()` へ渡す。done notification の full `text` は delta と重複するため
   resolver へ再投入しない。
2. stable item ID が確認できるまでは session 内連番を `utteranceId` に使い、推測した raw item ID を
   protocol contract にしない。
3. remote audio analyser の speech start / end を scheduler の start / complete へ接続する。
4. `onCue` で expression は既存 mood channel と別 ownership の発話演技 slot へ渡す。`neutral` は
   neutral preset の acquire ではなく、その slot の release として扱う。gesture は catalog 解決後に
   `Body.acquireMotionSlot()` へ渡す。
5. 現行 motion priority には「activity より低く idle より高い」lane がない。wiring 前に専用 lane を
   `state-driven` と `idle-fidget` の間へ追加し、発話由来 motion が明示 user motion / reflex / activity を
   preempt しないようにする。既存 `cancelAll()` は使わず、この adapter が所有する handle だけを止める。
6. barge-in、voice stop、disconnect は `cancelUtterance()` / `cancelAll()` へ接続し、`onRelease` で
   expression と motion handle を解放する。
7. 実機で transcript delta と audio の到着差を記録する。現 core の `atMs` は固定話速の推定なので、
   長い発話で誤差が累積する場合は inline tag や word alignment を仮定せず、speech activity / cue 到着時刻で
   節単位に再 anchor する adapter を比較する。

`App.tsx` と `src/runtime/codex-realtime/codex-realtime-client.ts` はこの core 追加では変更しない。
