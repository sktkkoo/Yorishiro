# Codex realtime voice

**Status**: experimental
**Last updated**: 2026-08-01

## TL;DR

Codex を Main Agent にしたとき、通常の TUI を残したまま title bar のマイクから
realtime voice conversation を開始できる。Codex TUI と音声 UI は session ごとの
`codex app-server` に同居し、同じ thread・approval・tool flow を共有する。

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

### 3. PTY observation-only 境界は変えない

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

- active Main Codex sessionとのrealtime音声会話
- 同じtop-level threadへのvoice / text historyの合流
- remote audio再生とVRM lip sync
- ChatGPT login / API key loginの継承とbilling表示
- stop、remote close、session切替、timeoutを跨ぐresource ownership

未実装:

- 複数agentをtask ID付きで編成・監督するTask Coordinator
- voice UIだけでのapproval確定
- progress / completionの構造化通知台帳
- semantic expression / gesture / motionの自動同期
- Claude / OpenCode / shell tabのrealtime voice

### expression / gesture

現行PRが同期するのはremote audioと口形だけである。spoken textへ`[smile]`等のinline tagを混ぜない。
server-sideで読み上げる可能性があり、shared transcriptも汚染するためである。

採用する方向は、assistant transcript deltaをhost側でsemantic intentへ解決し、spoken textとは別の
performance cueとしてBodyへ渡すside channelである。独立コアは`feat/realtime-performance-cues`
branchにあるが、Mainへのwiringは未実装である。

### Voice Summaryとの共存

GPT Liveは`connecting` / `active`の間だけ唯一の音声ownerとなり、Voice Summaryは
`idle` / `error`時のfallbackとする。Live開始時はVoicePlayerの再生中音声を停止し、
合成やclip取得のpublic `completion` / `waitUntilIdle`を即時cancelし、進行中のfetchもabortする。
cancel後にbackend promiseが完了してもgeneration guardで再生せず、`VoiceHandle.cancellationReason`で
通常完了・実エラー・host cancelを区別できる。所有中に届いた`voice_say` / `voice_play`は
`spoken: false` / `played: false`で完了し、切断後に古い要約を再生するqueueは持たない。
stop、remote close、start failure、session切替でいずれもVoicePlayerを即時復帰させる。

MCP tool requestにはRust側のevent作成時点でaudio ownershipの`ownerId` / `generation` /
`fallbackPlaybackEnabled`をstampする。WebView dispatch時のcurrent stateだけで判断すると、Live中に
作られたrequestがstop後に届いて古い要約を再生できるためである。handlerはrequest provenanceと
current VoicePlayerのowner ID + generationが完全一致する場合だけ再生する。owner IDはWebViewの
wall clockではなく、生存中のRust processがWebView incarnationごとに発行する。frontendからRustへの
ownership更新は同じowner ID内のgenerationで順序付けし、非同期invokeが逆順に完了しても古い更新を
採用しない。owner登録はcandidate発行と最初のstate更新によるactivationの二段階に分け、前WebViewの
遅延registerだけではactive leaseを奪えない。owner mismatchはIPC errorとして返し、frontendはcandidateを
再取得してからreconcileする。ただし古いgeneration / update attemptの後着errorは、より新しい成功済み
leaseをinvalidateしない。fallbackへのrestore IPCは一時失敗に備えてbounded retryする。

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
- v1 は active Main Codex session だけを対象とし、shell tab や Claude / OpenCode では
  button を表示しない

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
- synthesis / resolver / fetch待機中のLive開始でpublic completionと`waitUntilIdle`が即時完了する
- cancel後にfallbackを再有効化してもold generationの音声を再生しない
- stop / start failure / session切替 / unmountの全経路でfallback playbackを復帰する
- Live ownership provenance付きの遅延`voice_say` / `voice_play`を復帰後も再生しない
- clipの実エラーとhost cancellationを`VoiceHandle.cancellationReason`で区別する

加えて実機で、voice turnのTUI表示、TUI approval response、barge-in、session切替、remote close、
複数subagent稼働中のvoice開始を確認する。

## 関連 reference

- `src-tauri/src/sessions/pty_session.rs` — app-server process lifecycle
- `src-tauri/src/sessions/agent_adapter/codex.rs` — `--remote` launch
- `src/runtime/codex-realtime/` — JSON-RPC / WebRTC / lip sync
- `src/runtime/codex-realtime/use-codex-realtime.ts` — App-level client ownership
- `src/title-bar.tsx` — host-owned microphone UI
- [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [critical-constraints.md](critical-constraints.md) §1 PTY observation only
