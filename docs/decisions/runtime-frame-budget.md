# Runtime frame budget / GC — 毎フレーム処理の最適化境界とヘルスチェック

> このファイルは「**ターミナルや Yori の motion が一拍固まる**」「**voice / attention / scene の最適化で何を削ってよいか迷う**」「**GC や per-frame 負荷を health check したい**」時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-07-05

## TL;DR

Charminal の runtime は、住人の身体・視線・照明・scene が同じ画面で動き続けるため、**毎フレーム計算そのものは削ってはいけない**。削る対象は、steady frame 上の allocation、同値 publish、不要な DOM 計測、初回 interaction に乗る module load / reload である。

採る方針は次の 4 つ。

1. **計算は残し、container を再利用する**: `out` 引数 / scratch object / Set swap / Map reuse で、body / lip sync / camera / attention cue の steady-frame allocation を避ける。
2. **意味が変わった時だけ publish する**: attention source、workspace attention、session cwd などは同値なら store 更新・listener 通知・React commit を起こさない。
3. **workspace 切替は reload のまま残す**: folder 変更は runtime singleton 群の作り直しであり、frame 最適化の対象外。live respawn への置き換えは agent 自動起動と project-scoped state を壊したため却下（§6）。
4. **重い one-shot work を interaction frame から外す**: TTS の byte 受け渡しと WAV decode は JS の同期変換を通常経路にしない。

今回の実装基準は commit `f97444a8`（`Reduce runtime stutter and frame allocations`）、`b10f7bcc`（`Send synthesized TTS audio as raw bytes`）以降。

## 何を決めたか

### 1. 「per-frame 計算」と「per-frame allocation」を分ける

毎フレーム必要な計算は残す。たとえば以下は Charminal の存在感に必要な frame work なので、単純に throttle / skip しない。

- `Body.update()`: blink、eye state、breathing、procedural bones、micro expressions、lip sync、gaze apply
- R3F `useFrame()`: scene light flicker、camera modulation、attention cue light envelope、ambient motion
- terminal / DOM attention producer: 画面上の cursor / focused rect / terminal line を attention target として追う処理

削るべきものは、同じ計算をするために毎フレーム `new object` / `new Map` / `new Set` / `Array.from` / spread copy / closure を発生させること。frame path では「値を作る」のではなく「既存の入れ物に書く」を default にする。

### 2. frame path API は `out` / scratch を受け取れる形にする

frame loop 内で値 object を返す API は、可能なら caller-owned buffer を受け取れる形にする。

今回採用した pattern:

- `LipSyncAnalyser.sample(out?)` / `VoicePlayer.sampleMouth(out?)`: mouth values を caller scratch に書けるようにする。
- `CursorAttention.writeOutput(out)` / `EyeSystem.writeOutput(out)`: public `getOutput()` は外部向け copy を維持し、Body の frame path だけ mutable output を使う。
- `IdleMicroexpressionSystem.writeUpdate(delta, enabled, out)`: public `update()` は copy-returning のまま残し、Body の frame path では micro-expression event object を再利用する。
- `ExpressionManager.writeResolved(result)`: resolved expression map を caller-owned `Map` に書く。
- `computeAttentionCueLightIntensityInto(elapsed, out)`: light cue の intensity result を再利用する。
- `CameraModulationManager.evaluatePosition(elapsed, delta, out)`: scene pack の camera modulation callback も `out` に書く契約にする。
- scene pack 側: `addPositionModulation` callback は `{ x, y, z }` を毎フレーム返すのではなく、渡された `out` を mutate して返す。

公開 API と test ergonomics のために copy-returning method を残すのはよい。ただし runtime hot path は mutable variant を使う。

### 3. Set / Map / array は「clear + swap」で再利用する

`new Set()` / `new Map()` は小さく見えても、60fps の body / attention path に入ると GC cadence を作る。今回の修正では次を採った。

- terminal attention producer: seen/current の line set を frame ごとに swap し、次 scan 前に `clear()` する。
- expression sink tracking: previous/current の key set を swap して、削除差分を取る。
- attention resolver: `Array.from(sources.values())` をやめ、`Iterable` をそのまま処理する。
- attention runtime listener notify: listener `Set` を毎回 array 化しない。
- beat scheduler: `profile.beats.filter()` や pending action の残リスト再生成を避け、候補選択と pending queue は in-place にする。

copy を作る場合は、reentrancy safety や mutation isolation が必要な理由を明示する。理由がなければ iterable / swap / scratch を使う。

### 4. DOM / xterm geometry は必要な時だけ読む

`getBoundingClientRect()` や xterm buffer scan は、layout flush や object churn の温床になりやすい。すべてを禁止するのではなく、次の境界に閉じる。

- input cursor / focused DOM producer は scan 時だけ rAF で追ってよいが、interval 待機中に rAF を常駐させない。rect が変わらなければ `attention.setSourceTarget()` しない。ただし attention-resolver は kind 別 maxAge で stale target を除外するため、dedup で timestamp を凍結させず keep-alive 間隔（maxAge より短い）で再 emit して freshness を維持する。
- terminal attention scan は一定間隔でよい。毎 frame xterm tail を全文 parse しない。
- terminal attention scan は interval 待機中に rAF を常駐させない。timer 到達後に 1 回だけ rAF に合わせて scan し、xterm の frame 確定と意味検出を両立する。
- attention aura の animation rAF は DOM ref へ直接 style を書く。rAF ごとの React `setState()` / commit は terminal typing や attention target 追従と競合するため避ける。
- lip-sync analyser は音声再生中だけ pull する。発声終了後に Web Audio graph が残っていても、Body の毎 frame update から `AnalyserNode.getByte*Data()` を呼び続けない。
- decay が完了した one-shot visual effect は pack の `dispose()` 待ちにせず、renderer primitive 側で rAF を停止する。0 transform を書くだけの frame loop は残さない。
- R3F `useFrame` subscriber は idle 常駐させない。attention cue light のような one-shot 演出は active cue 中だけ frame callback を mount する。
- `TerminalRuntime.getViewportLineRects()` は caller 向け array を維持しつつ、内部 rect entry を cache / reuse する。
- `getInputCursorClientPosition()` は `{ x, y }` object を毎回作らず、runtime-owned object を返す。
- 再利用バッファを返す API の caller は、値を呼び出しをまたいで保持するなら複製する（terminal producer の emitLine が rect を複製するのはこの契約）。
- PTY output burst では chunk ごとに debounce timer を clear/set しない。期限だけ更新し、active timer は screen-attention scan / output settle それぞれ 1 本に保つ。
- PTY output / user input / viewport scroll listener notify は snapshot 配列を作らない。reentrancy isolation が必要な listener だけ例外として明示する。
- `pty-output` は SDK event として残すが、raw chunk ごとに EventBus の全 trigger match を走らせない。Perception 側で短時間の text を coalesce し、観測意味を保ちながら dispatch 回数を抑える。

DOM 計測の目的は「attention target の位置更新」であり、React state 更新や store publish のために毎 frame 使わない。

### 5. store publish は同値なら no-op にする

store publish は React commit、subscriber work、cue bridge scan を誘発する。値が同じなら publish しない。

今回の例:

- input cursor / focused DOM producer: rect が同じなら attention source を更新しない（keep-alive 再 emit で freshness だけは維持する）。
- `WorkspaceAttentionStore.upsert()`: active item の locus / type / severity / detail が同じなら no-op。
- `ExpressionManager.setWeight()`: weight が変わらなければ no-op。

「publish したいから同じ値を set する」は避ける。必要なのが heartbeat なら、値更新ではなく別の event として設計する。

### 6. folder 切替は reload のまま残す（live state transition は却下）

一度 live respawn（`setCwd()` + main session launch cwd 差し替え + force restart）への置き換えを試したが、**却下して reload（curtain reload）に戻した**。理由:

- App の bootstrap は project-scoped state（project root 解決、scene-per-project、perception 文脈、greeting）を WebView load ごとに 1 回だけ解決する。PTY respawn だけ live に差し替えても、これらが旧 folder のまま残る半端な切替になる。
- agent の自動起動が reload 後の boot フローに乗っているため、live respawn 置き換えはフォルダ変更時の agent 自動起動を壊した。
- `handlePickFolder` の in-code comment（「PTY / xterm / perception の寿命が絡むため、差分更新より WebView reload の方が安定する」）が警告していた通りの症状で、branch 内で 3 回修正を重ねても安定しなかった。

folder 変更は「直接操作」ではなく workspace 全体の context switch として扱う。体感の硬さは `useReloadCurtain` の暗転フェードで吸収する（main 実装済み）。frame budget 最適化の対象は steady frame であり、この one-shot の重い遷移ではない。

### 7. voice は async one-shot と playback frame loop を分ける

VoiceSummary / Yori speaking で固まりやすい経路は、TTS synth / fetch / decode / audio graph setup と、再生中の lip sync frame loop が重なって見える。

境界:

- synth / fetch / `decodeAudioData()` は one-shot async work。ここは allocation ゼロにはならないが、steady frame budget とは別枠として扱う。
- TTS synth result は base64 文字列で返さない。Rust から `Channel<ArrayBuffer>` の raw bytes で渡し、JS の `atob` / byte copy を発話開始 frame に乗せない。
- PCM WAV は通常経路で JS の per-sample loop に通さない。まず native `AudioContext.decodeAudioData()` に渡し、失敗時だけ `decodePcm16Wav()` fallback を使う。
- lip sync rAF loop と Body の `sampleMouth()` は playback 中だけ動かす。
- App の Body 接続は `VoicePlayer.sampleMouth(out)` の pull 型なので、`setMouthCallback()` が未設定なら VoicePlayer 側の push rAF loop を起動しない。Body pull と VoicePlayer push を二重に動かさない。
- mouth values は scratch object へ書く。`{ ...ZERO_MOUTH }` や raw mouth object を毎 sample 作らない。
- Body は lip sync を 1 frame に 1 回だけ sample する。二重 sample は smoothing を二重に進めるので禁止。

「lip sync が重いから sample を間引く」は最後の手段。まず allocation と二重 sample を消す。

## なぜそう決めたか

### 症状

今回の調査対象は、`codex/attention-light-flash` 系の作業中に見えた次の停止感。

1. プロジェクトフォルダ変更のためフォルダボタンをクリックしたタイミングで、Yori / motion / 画面が一拍固まる。
2. VoiceSummary などで Yori が声を出すタイミングで、Yori / motion / 画面が一拍固まる。

どちらも「単一の重い関数」だけでなく、interaction に module load / reload / audio decode / frame allocation / store publish が重なると悪化する。

### 判断

- folder picker の reload は「隠せない停止」だが、live respawn への置き換えは agent 自動起動と project-scoped state を壊した（§6）。ここは curtain reload で体感を吸収し、frame budget 最適化の対象から外す。
- voice は synth / decode 自体を完全に消せない。だから playback 中の lip sync / body path から GC を消し、decode 完了後の steady frame を安定させる。
- attention / workspace store は「目に見えない publish churn」が画面停止に寄与する。意味が変わらない更新は削る。
- scene / body の per-frame 計算を減らすより、allocation と redundant publish を消す方が presence を壊さずに効く。

## ヘルスチェック

### 静的チェック

perf regression を疑う時は、まず hot path に次が入っていないか見る。

```bash
rg -n "useFrame|requestAnimationFrame|setInterval|setTimeout|new Map|new Set|Array\\.from|\\.map\\(|\\.filter\\(|\\.reduce\\(|\\.slice\\(|\\.sort\\(|\\.\\.\\.|\\.getBoundingClientRect|setState|setSourceTarget|window\\.location\\.reload" src bundled-packs
```

見る観点:

- `useFrame` / rAF callback 内で object literal / array literal / `new Map` / `new Set` / spread copy を作っていないか。
- `Array.from(this.listeners)` のような listener snapshot が frame path にないか。reentrancy safety が必要なら理由を comment する。
- `filter()` / `map()` / `slice()` が「毎フレームではなく時々だから安全」として render-loop 内に残っていないか。beat / micro-expression のような低頻度発火でも GC spike になるなら in-place にする。
- rAF callback が「elapsed を見て return するだけ」の polling loop になっていないか。低頻度 scan は timer + one-shot rAF にして、待機中の per-frame callback を消す。
- PTY output subscriber が output chunk ごとに `clearTimeout()` / `setTimeout()` を繰り返していないか。debounce は deadline update + single active timer にする。
- `Perception.onPtyOutput()` が raw chunk ごとに EventBus dispatch していないか。`pty-output` は coalesced text event として扱う。
- `getBoundingClientRect()` が frame ごとに複数箇所で走っていないか。rect unchanged なら publish skip しているか。
- store `set` / `upsert` / `notify` が同値でも発火していないか。
- `window.location.reload()` が steady frame の実装に紛れ込んでいないか。folder 切替の `beginCurtainReload()` は意図された例外（§6）。
- dynamic `import()` が初回 click / first speech に乗っていないか。必要なら idle preload する。
- TTS / voice clip の通常経路が `atob`、base64 decode、JS の PCM per-sample decode に戻っていないか。

### Runtime profiling

Tauri / Chrome DevTools の Performance recording で、少なくとも次の 3 ケースを測る。

1. idle 10-20 秒: Yori motion / scene / terminal が表示された状態。
2. folder button click → dialog open: click 直後に long task / React commit burst がないこと。folder select 後の curtain reload は意図された遷移として扱う。
3. VoiceSummary 相当の speech: synth / decode の one-shot work 後、playback 中に periodic minor GC が出ないこと。

目標:

- idle / playback 中の JS heap は sawtooth ではなくほぼ平坦。
- steady frame の minor GC が継続的に出ない。
- UI thread long task は直接操作中でも 50ms を超えない。audio decode 等の one-shot が見える場合は、frame animation と重なる範囲を分けて評価する。
- React commit は terminal output stream や attention scan のたびに連続発生しない。
- GPU / R3F frame は attention cue / camera / light の計算を維持したまま安定する。

「GC ほぼ 0」は steady frame の条件であり、startup、pack load、dialog module preload、audio fetch / decode、folder selection の snapshot 更新まで allocation ゼロを要求するものではない。

### Regression guard

最適化時に削ってはいけないもの:

- Body の per-frame update sequence。blink / breathing / eye / procedural bones / lip sync / gaze apply は presence の基礎なので、重いからといって global throttle しない。
- attention cue light の envelope 計算。pulse shape は毎 frame の連続値で成り立つので、イベント発火時だけ intensity を変えない。
- scene pack の camera / light modulation。callback の実行は残し、戻り値 allocation を `out` mutation に変える。
- lip sync sample の頻度。まず `sample(out)` と scratch reuse で GC を消し、sample 間引きは音声表現の劣化として扱う。
- terminal attention の意味。scan interval / cache / skip unchanged はよいが、permission / diagnostic / file-link の検出意味を落とさない。

最適化してよいもの:

- 同じ値の publish。
- frame path の object / array / Map / Set allocation。
- click path の dynamic import（preload へ移す）。
- audio decode は native async path を優先し、JS fallback を failure path に閉じる。
- external caller 用 copy-returning API と runtime 用 mutable API の併存。

## 検討したが却下した代替案

- **Body / R3F を低 fps に throttle**: 却下。停止感は減るかもしれないが、住人の身体性と scene の連続性を直接落とす。presence の質を下げる最適化。
- **lip sync を間引く / 無効化する**: 却下。VoiceSummary の体験そのものを劣化させる。まず allocation と二重 sample を消す。
- **folder 切替を live state transition にする**: 一度実装したが却下。PTY respawn は差し替えられても、bootstrap が 1 回だけ解決する project-scoped state（project root / scene-per-project / perception 文脈）が旧 folder のまま残り、agent 自動起動も壊れた。reload + curtain fade を正とする。
- **PCM WAV を常に JS で直接 AudioBuffer に変換する**: 却下。native decode の互換性問題を避けられるが、VoiceSummary のような長い音声では per-sample loop が main thread long task になる。fallback としてだけ残す。
- **deep equality を `JSON.stringify` で済ませる**: 却下。比較のために allocation / stringify CPU を増やす。hot path は field-level shallow compare にする。
- **すべての API を mutable にする**: 却下。外部 caller / tests / SDK では immutable return の方が安全な場面がある。runtime hot path だけ mutable variant を使う。

## この決定の implication / 制約

- 新しい frame path API は、返り値 object だけでなく `out` 引数を設計する。公開 surface で copy を返す場合も、runtime 内部には mutable variant を置く。
- scene pack の per-frame callback は、allocation-free に書ける signature を優先する。旧 signature を変える場合は `src/sdk/scene-pack.d.ts` と bundled pack を同時更新する。
- store / runtime の `set` 系 method は、同値 no-op を default とする。例外的に同値 publish が必要なら、それは value update ではなく explicit event として設計する。
- profiling の合格条件は「何もしていない」ことではない。毎 frame の生理的 motion と attention cue は走ってよい。問題は、毎 frame で不要な memory churn / publish churn を起こすこと。
- large perf refactor は、unit test だけでは完了扱いにしない。最低限、Performance recording で idle / folder click / speech playback を確認する。

## 関連 reference

- 実装 commit: `f97444a8`（`Reduce runtime stutter and frame allocations`）
- body / voice: `src/core/body/index.ts`, `src/core/body/expression-manager.ts`, `src/core/body/cursor-attention.ts`, `src/core/body/eye-system.ts`, `src/core/voice/lip-sync-analyser.ts`, `src/core/voice/voice-player.ts`
- attention / terminal: `src/runtime/attention-runtime/attention-runtime.ts`, `src/runtime/attention-producers/terminal.ts`, `src/runtime/attention-producers/input-cursor.ts`, `src/runtime/attention-producers/focused-dom.ts`, `src/runtime/terminal-runtime/terminal-runtime.ts`, `src/runtime/workspace-attention/workspace-attention-store.ts`
- scene / cue: `src/runtime/three-runtime/attention-cue-envelope.ts`, `src/runtime/three-runtime/attention-cue-light.tsx`, `src/runtime/three-runtime/camera-modulation.ts`, `src/sdk/scene-pack.d.ts`, `bundled-packs/scenes/abandoned-factory/lib/camera-breath.tsx`
- folder picker: `src/App.tsx`
- TTS raw audio: `src-tauri/src/tts.rs`, `src/core/voice/tts-engine.ts`
- 関連 decision: [`render-on-resize-managed-layer.md`](render-on-resize-managed-layer.md), [`presence-over-spectacle.md`](presence-over-spectacle.md), [`interaction-as-presence.md`](interaction-as-presence.md), [`cognitive-load-design-lens.md`](cognitive-load-design-lens.md)

## 改訂履歴

- 2026-07-05: folder 切替の live state transition を却下し、curtain reload 維持に戻す。live respawn は agent 自動起動と project-scoped state（project root / scene-per-project / perception）を壊すため、workspace 切替は frame budget の対象外と明記。
- 2026-07-05: TTS synth result を raw channel にし、PCM WAV の JS per-sample decode を fallback に下げる判断を追記。
- 2026-07-05: Body の beat / micro-expression / eye refocus hot path で、低頻度でも render-loop 内に残る配列・event object 生成を再利用へ寄せる判断を追記。
- 2026-07-04: 初版。folder picker / VoiceSummary 付近の停止感を契機に、frame path allocation 削減、同値 publish no-op、voice / body / attention / camera の mutable-output pattern を decision と health check として記録。
