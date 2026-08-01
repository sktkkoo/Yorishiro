# Codex realtime voice

**Status**: experimental
**Last updated**: 2026-08-01

## TL;DR

Codex を Main Agent にしたとき、通常の TUI を残したまま title bar のマイクから
realtime voice conversation を開始できる。Codex TUI と音声 UI は session ごとの
`codex app-server` に同居し、同じ thread・approval・tool flow を共有する。

### 発話テキスト（transcript）

このDecisionでいうtranscriptは、音声会話の一回の発話を文字で表した**発話テキスト**である。
user側ではmicrophone音声の文字起こし、Main Agent側では生成して読み上げている内容の文字表現を指す。
完成文が一度に届くとは限らず、`delta` eventで断片が増え、`done` eventでその発話が確定する。

発話テキストは実際にspeakerへ流すaudioとは別streamで届く。terminal log全体やconversation history全体を
意味せず、audioと発話テキストの到着順にも保証はない。

## 設計を読む前の4つの前提

1. **audio、発話テキスト（transcript）、tool / work eventは独立したstreamであり、到着順を保証しない。**
   textがaudioより先に届く場合も、短いaudioが最初のtranscriptより先に終わる場合もある。
   arrival orderから同一responseだと推測せず、response / itemのidentityとgenerationで対応づける。
2. **非同期resourceはboolean stateではなくownershipで管理する。**
   connection、microphone、audio playback、expression、motionにはownerとなるattempt / response / handleを
   持たせる。古いownerは、stop、切替、user発話割り込み後の新しいresourceやstateを変更してはならない。
3. **WebViewとRustに跨るstateは、片側の更新だけで正しいとみなさない。**
   Rust processやMCP serverはWebView reload後も生きることがある。voice ownershipのような共有stateは
   provenance付きかつidempotentに同期し、失敗を再試行または明示的にreconcileできるようにする。
4. **表情・motionのproducerと、最終的な合成判断を分ける。**
   blink、lip sync、microexpression、persona / MCP、Agent State ExpressionはVRMへ個別に最終判断を
   書き込まず、共通のpriority、region、weight budget、ownershipを通す。最終weightの集約は現在の
   `ExpressionManager`が担う。producer側に散らばるpolicyの集約は[#83](https://github.com/sktkkoo/Yorishiro/issues/83)
   で段階的に行い、このDecisionが未実装の完全統合を主張しないようにする。

これらの境界はhappy pathだけでは検証できない。audio / transcriptの順序を入れ替える、処理を遅延させる、
途中でstop / reload / IPC failureを起こすtestを、通常の成功testと同じ設計契約として扱う。

## 何を決めたか

### 1. TUI は残し、app-server を共有する

Codex session の起動は次の 3 要素に分ける。

1. Rust が random loopback port で `codex app-server --listen ws://127.0.0.1:<port>` を起動
2. PTY 内の Codex TUI を `codex --remote <endpoint>` で同じ server へ接続
3. Rust の realtime bridge が Origin header なしで同じ server へ接続
4. WebView の `CodexRealtimeClient` は Tauri Channel 経由で `thread/loaded/list` を送り、
   複数件なら `thread/read` の `parentThreadId` で subagent を除外した唯一の top-level thread を選ぶ
5. 選んだ thread で `thread/realtime/start` の realtime v3 + WebRTC transport を開始

app-server process は `PtySession` が所有する。spawn 途中の失敗、session kill、Drop の
どの経路でも child を kill + wait し、orphan process を残さない。

### 2. 音声 UI は host 所有

マイク button、WebRTC、macOS microphone permission、音声出力は Yorishiro host が持つ。
agent / persona / pack には endpoint や任意の音声送信 API を公開しない。

remote audio は Web Audio の `LipSyncAnalyser` に接続し、通常の Voice Summary と同じ
`LipSyncSource` contract で Body が口形素を pull する。音声 session 終了時は既存の
`VoicePlayer` に戻す。

Realtime v3 の voice は session 開始時に `sol` を明示する。Codex 0.145.0 の v1/v3
voice list に含まれる音声合成プリセットであり、未指定時の `cove` には依存しない。

### 3. 音声 transport は Main Agent の native capability に合わせる

Yorishiro は provider に依存しない共通 shell として、マイク button、permission、audio output、
lip sync、Agent State Expression、接続状態 UI を所有する。一方、会話 thread への接続、transcript、
tool / approval event、handoff は各 harness の native voice adapter が所有する。

v1 で実装する first-class adapter は Codex である。Codex app-server が TUI と realtime voice を
同じ thread に接続できるため、音声から依頼した作業、subagent の進捗、tool execution、approval、
text history を一つの流れとして保持できる。これは単に PTY output を読み取ることとは異なる。

将来 Claude Code、OpenCode、または別の harness が同じ conversation / work session に接続する
native realtime voice capability を提供した場合は、その harness 専用 adapter を追加する。active な
Main Agent が Claude Code なら Claude の native voice、Codex なら GPT Live、という対応にする。
音声のためだけに別 provider の thread へ会話を複製しない。

Main Agent と voice adapter の概念名は provider-neutral に保つが、未実装 provider を Codex と同等に
見せる疑似互換は作らない。必要な capability がない harness では、共通マイク button から現在の制約と
利用可能な切替先を説明できるが、user の明示確認なしに Main Agent を自動切替してはならない。

### 4. PTY observation-only 境界は変えない

音声入力は app-server の thread API に入り、PTY stdin には書かない。realtime response は
同じ Codex thread に合流するため、承認・tool execution・text history は Codex 側の通常の
UI に残る。これは PTY を「AI が user の代わりに操作する経路」にしないという
[critical constraints](critical-constraints.md) §1 と両立する。

## なぜそう決めたか

- Realtime 専用 UI に置き換えると、Codex TUI の approval、tool progress、履歴が失われる
- 別 thread で音声を始めると、text と voice の context が分断される
- app-server は複数 client が同じ loaded thread を扱えるため、TUI を primary UI のまま
  voice を補助 UI として足せる
- WebRTC は browser の microphone / echo cancellation / audio output をそのまま利用できる

## 実装上の契約

### TUI と voice bridge は別 client

TUI と voice bridge は同じ app-server へ接続する独立 client である。文章が同一になるという意味では
なく、同じ thread state と event stream を共有する。

Codex 0.146.0 で次を実測した。

- `thread/realtime/start` は呼び出し元 bridge client を対象 thread へ自動 subscribe する
- realtime transcript / handoff / 通常 turn event は TUI 相当 client と bridge client の双方へ届く
- approval request は全 subscriber へ同じ request ID で届き、最初の response で解決する

したがって voice bridge に `thread/resume` を追加しない。二重 resume は ownership を明確にせず、
別の副作用を増やす。

### thread targeting

`thread/loaded/list` は active TUI thread を返す API ではない。loaded ID を文字列 sort した一覧であり、
`data[0]` は active thread を意味しない。先頭採用は禁止する。

Main Agent が agent team を動かすと同じ app-server に複数 thread が loaded になるが、これは異常では
ない。対象は次の手順で決める。

1. `thread/loaded/list` を取得する
2. 各 ID を `thread/read({ includeTurns: false })` で読む
3. `parentThreadId === null` の top-level thread だけを候補にする
4. top-level が一つなら、その ID で realtime を開始する
5. subagent の終了と read が競合した場合は、最新の loaded snapshot からやり直す
6. top-level が複数なら推測せず fail closed する

Codex v2 Thread schema は `parentThreadId` を subagent の場合だけ設定する。recency、配列順、statusから
active threadを推測してはならない。upstreamがactive threadの明示query / notificationを提供した場合は、
この選択を明示IDへ置き換える。

### approval ownership

approval UI の正本は TUI である。

- `id + method` は server-initiated request として分類する
- `id + result` または `id + error` だけを client request の response として扱う
- bridge は approval request に自動 approve / decline を返さない
- TUI が利用不能な状態で自動承認する fallback を作らない

approvalは全subscriberへfan-outされ、first-response-winsである。bridgeが独自応答するとTUIと競合する。
voice approval UIを正式に設計するまではTUIへ委ねる。

### start / stop ownership

非同期startとUI stateは二層で所有権を守る。

`CodexRealtimeClient`:

- startごとにattempt epochを取得する
- stop、timeout、remote closedでepochを無効化する
- 各`await`後にcurrent attemptか確認する
- timeout後に遅れて返ったbridge connectionは即disconnectする
- stop後に遅れて返ったmicrophone trackは即stopする
- 古いattemptは新しいattemptのpeer、audio、stateを変更できない

`useCodexRealtime`:

- current clientからのstateだけをUIとBodyへ反映する
- session切替やstop後に古い`start()`が失敗してもerror UIへ戻さない
- remote `idle`でclient ownershipを解放し、次の1クリックで再接続する
- voice unavailableなsessionへ移ったら古いerrorもidleへ戻す
- current clientがactiveな間だけ、そのclientをlip sync sourceにする

Appだけのgeneration guardではlate Rust/WebRTC resourceを閉じられず、clientだけのepochではstale React
refを解放できないため、この二層を一つに省略しない。

### audio startup order

1. user gesture直後にAudioContextをresumeする
2. Rust bridgeへ接続してapp-serverをinitializeする
3. `account/read`で認証・billingを確定する
4. top-level threadを確定する
5. ここで初めてmicrophone permissionを要求する
6. WebRTC offer / ICE / realtime start / remote SDPを完了する
7. remote audioを再生し、同じstreamを`LipSyncAnalyser`へ接続する

課金やthread選択が不明な状態でmicrophoneを先に取得しない。

## 現在の機能境界

実装済み:

- activeなCodex-backed Main Agent sessionとのrealtime音声会話
- 同じtop-level threadへのvoice / text historyの合流
- remote audio再生とVRM lip sync
- ChatGPT login / API key loginの継承とbilling表示
- stop、remote close、session切替、timeoutを跨ぐresource ownership
- assistant transcriptから読み取れるMain Agentの状態を、spoken textと分離した表情・身体反応で補足

未実装:

- 委任作業の状態を会話向けに投影するWork Status Ledger
- voice UIだけでのapproval確定
- progress / completionの構造化通知台帳
- Main Agent capabilityに応じたprovider別voice adapter選択
- Claude / OpenCodeがnative realtime voiceを提供した場合の専用adapter
- 非対応harnessでも機能を発見できる共通マイクbuttonと明示的な切替導線

### Agent State Expression（旧 performance cue）

spoken textへ`[smile]`等のinline tagを混ぜない。server-sideで読み上げる可能性があり、shared transcriptも
汚染するためである。

この機能の目的は、avatarに装飾的な「演技」をさせることではない。Main Agentが会話で表している
認知・感情状態を、textだけでは落ちる情報も含めて表情と小さな身体反応へ投影することである。
domain conceptは **Agent State Expression**、個々の出力は`StateExpressionCue`と呼ぶ。

assistant transcript deltaをhost側でsemantic stateへ解決し、spoken textとは別のstate expression cueとして
Bodyへ渡すside channelを採用する。remote audioのlip-sync sampleから得る**発話タイムライン**
（speech clock。textの到着時刻ではなく、実際の音声再生開始を基準にした時間軸）でspeech start/endを検出し、
表情は専用`speech` slot、gestureはactivityより低くidleより高い`speech-expression` laneへ渡す。
user transcriptによる**ユーザー発話割り込み**（barge-in。Main Agentの発話中にuserが話し始めること）、
voice stop、disconnect、session切替では、このadapterが所有するhandleだけを解放する。語単位timestampは
無いため、実機計測後の節単位re-anchorは今後の調整対象である。

現在観察できる正本は発話内容とspeech lifecycleであり、modelの非公開な内部感情を読めるとは扱わない。
難しい検討、不確実性、困惑、発見、安心、懸念、同意など、発話に根拠がある状態だけを解決する。
ただし、表情を離散的な「状態変化」が起きた瞬間だけに限定しない。一度根拠づけられた状態は一定時間
継続し、その範囲では低salienceな微笑み、考え込む仕草、視線や姿勢の小さな揺らぎを有機的な
micro-variationとして許容する。randomnessは発生時刻、variant、弱いintensityを選ぶためだけに使い、
根拠のない新しい感情categoryや強い表情を生成するためには使わない。

したがって表現は二層に分ける。発話やstructured stateに直接根拠づけられたsalient expressionと、
そのgrounded stateが続く間のlow-salience organic variationである。前者は状態の意味を正確に伝え、
後者は人間らしい連続性と頻度を補う。同じsalient expressionの連打はcooldownで抑え、grounded stateが
無い箇所では、感情を捏造せずblink、breathing、gazeなどの生理的baselineだけを維持する。

motionと表情の強弱はstate expression cueの`intensity`で表現し、Body adapterがanimation / expression
weightへ変換する。routineな状態は`small`、明確な感情・強調だけを`medium`にする。
当面はhost共通のsemantic state→body mappingを使い、personaごとのmotion、weight、expression
mappingは導入しない。persona固有のstate expression catalogは、共通mappingを実機で安定させた後に
別途設計する。

### Voice Summaryとの共存

GPT Live接続中にVoice Summaryを自動再生すると音声の重複や割り込みが起きる。GPT Liveをactive時の
唯一の音声owner、Voice Summaryをfallbackにする方向が妥当だが、抑止範囲、未通知resultの扱い、
切断後の復帰方法は未決定である。現時点では挙動を変更せず、別decisionで確定する。

## 今後も守る invariant

1. PTY stdinへvoice transcriptを書かない
2. active threadをloaded配列順、recency、statusから推測しない
3. subagentが複数loadedであることだけをerrorにしない
4. 複数top-levelを勝手に選ばない
5. bridgeがapprovalへ自動応答しない
6. billingとthread確定前にmicrophoneを要求しない
7. stale attempt/clientがcurrent stateやresourceを変更できないようにする
8. app-server endpointをWebView、pack、LANへ公開しない
9. spoken textへ機械制御tagを混ぜない
10. 将来のstructured task stateで自然なconversation historyを置き換えない
11. native voice capabilityがないharnessを、PTY log転送で疑似的に同等扱いしない
12. voice利用のためにMain Agentをuser確認なしで自動切替しない
13. 発話やstructured stateに根拠がない感情を、見栄えのためだけに生成しない
14. domain conceptをperformance / actingとして扱わず、Main Agentのstate expressionとして扱う
15. randomnessで感情categoryを決めず、grounded state内の低salienceなtiming / variant / intensityだけを揺らす

## Security / known limitations

- 対応は **Codex 0.145.0 以降**。`app-server` / `--remote` / realtime API は Codex の
  experimental surface であり、上流変更に追従が必要
- server は session ごとの random port で `127.0.0.1` のみに bind するが、現在の
  WebSocket transport 自体に client authentication はない。endpoint は Rust host 内でだけ
  解決し、WebView / pack には公開せず、LAN にも公開しない
- Codex app-server は Origin header 付き handshake を拒否する。WebView は Origin を外せない
  ため、Origin なしで接続できる Rust host が JSON-RPC text だけを IPC 中継する。CSP に
  loopback WebSocket の許可は追加しない
- microphone は user がマイク button を押した時だけ要求し、終了時に全 track を stop する
- 音声開始前に `account/read` を確認し、Codex CLI の現在の認証をそのまま使う。
  `account.type === "chatgpt"` なら ChatGPT subscription、`account.type === "apiKey"` なら
  OpenAI API の従量課金で開始する。API key 認証時は microphone / Realtime の開始前から
  title bar に「API従量課金」を表示し、active な間も常時表示する。認証方式が不明な場合は
  開始しない
- realtime voice は Codex 側でも experimental。利用可否・voice・model は Codex account と
  upstream configuration に依存する
- Codex 0.146.0 の実測では、`thread/realtime/start` を呼んだ bridge client は対象 thread へ
  自動購読され、TUI と bridge の双方へ realtime transcript、handoff、通常 turn event が届く
- approval request は同じ thread の subscriber 全員へ届く。bridge は自動応答せず、v1 の
  承認 UI は TUI だけを正本とする
- `thread/loaded/list` の順序には active thread の意味がない。subagent は `parentThreadId` で除外し、
  複数の top-level thread が loaded の場合は誤接続を避けて voice を開始しない
- v1 の接続実装は activeなCodex-backed Main Agent session だけを対象とする。shell tab や Claude / OpenCode には
  native voice adapterがなく、現在はbuttonも表示しない。将来の共通buttonは非対応を隠さず説明し、
  userが明示確認した場合だけ既存の安全なagent切替経路を使う

## 検討したが却下した代替案

### A. 音声 transcript を PTY に type する

却下。PTY observation-only 境界を破り、approval UI の入力と衝突する。

### B. TUI を捨てて Yorishiro が app-server UI 全体を実装する

却下。approval / tool / history / interruption の再実装範囲が大きく、通常の Codex terminal
experience を失う。

### C. realtime 専用の別 Codex process / thread を起動する

却下。text と voice の context が分断され、「同じ住人との会話」にならない。

### D. `thread/loaded/list.data[0]` を active thread とみなす

却下。配列順にactive selectionの契約がない。

### E. loaded threadが2件以上なら常に停止する

却下。agent teamを使うだけでsubagent threadが複数loadedになる。top-levelとsubagentを区別する。

### F. voice bridgeもapprovalへ返答する

却下。全subscriberへのfan-outとfirst-response-winsによりTUIと競合する。

### G. spoken textへexpression tagを埋め込む

却下。読み上げ漏れ、streaming chunk分割、shared history汚染を避けられない。

## Verification contract

- sole top-level + 複数subagentからtop-levelを選ぶ
- thread readとsubagent unloadの競合はfresh snapshotからretryする
- 複数top-level / malformed threadはmicrophone取得前にfail closedする
- server requestをresponseとしてconsumeしない
- connecting中stop後のlate errorはUIを上書きしない
- timeout後のlate connection、stop後のlate microphoneを解放する
- remote closed後は一回のクリックで再接続する
- old attempt/clientがnew active clientを破棄しない

加えて実機で、voice turnのTUI表示、TUI approval response、ユーザー発話割り込み、session切替、remote close、
複数subagent稼働中のvoice開始を確認する。

## 関連 reference

- `src-tauri/src/sessions/pty_session.rs` — app-server process lifecycle
- `src-tauri/src/sessions/agent_adapter/codex.rs` — `--remote` launch
- `src/runtime/codex-realtime/` — JSON-RPC / WebRTC / lip sync
- `src/runtime/codex-realtime/use-codex-realtime.ts` — App-level client ownership
- `src/title-bar.tsx` — host-owned microphone UI
- [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [critical-constraints.md](critical-constraints.md) §1 PTY observation only
