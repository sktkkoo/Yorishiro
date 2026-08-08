# Codex Sidecar Lifecycle

**Status**: active
**Last updated**: 2026-08-08

## TL;DR

app 終了時に PTY session と Codex app-server sidecar を停止し、次回起動時に取り残された sidecar を整理する。この lifecycle は build profile（debug / release）で分けない。

自己改修セッションを Rust hot reload から守る仕組みは、この lifecycle の例外としてではなく、将来の session supervisor として別途設計する。

## 何を決めたか

Codex session ごとに起動する `codex app-server --listen <endpoint>` の lifecycle を、全 build profile で同一にする。

- sidecar spawn 時に `{ ownerPid, sidecarPid, endpoint }` を `~/.yorishiro/runtime/codex-sidecars.json` へ記録する。
- 正常な teardown 時は sidecar を停止し、registry entry を除去する。
- `RunEvent::Exit` で全 PTY session を明示的に停止する。
- 次回起動時、owner を失った sidecar だけを process identity 照合後に回収する。

## なぜそう決めたか

Codex CLI 0.147.0 以降は `~/.codex/thread-writer-locks/` の writer lock を使う。Tauri managed state は process exit で Drop されるとは限らず、leak した app-server が lock を握り続けると、次回の `resume --last` が `-32600 already has an active writer` で失敗する（issue #109）。明示的 teardown と次回起動時 reaper の二層は、この故障を塞ぐための最小構成であり、どちらを欠いても leak 経路が残る。

reaper 後も別の正当な Codex client が最新 thread を使用中なら、その process は停止しない。
Yorishiro は同一 thread の resume を先に試し、active writer error の場合だけ同じ履歴を
fork して起動を継続する。これにより stale sidecar は可能な範囲で回収しつつ、利用中の
別 client を巻き込まずに Terminal を開ける。

debug build を例外にしない理由は経験的で、実装当日に確認された。Rust hot reload で backend process が再起動すると、現行構成では旧 process が所有していた PTY との接続が切れ、新 process から再 attach できない。sidecar だけ残しても session の継続は得られず、残留 sidecar が writer lock を握って次の session の `resume --last` を塞ぐ——つまり issue #109 と同じ故障を dev loop 内で再現する。実際、debug でこの teardown / reaper をスキップする変更を入れた直後の dev iteration で `-32600` が再発し、手動 cleanup が必要になった。

## 検討したが却下した代替案

### debug build では teardown / reaper をスキップする（自己改修セッション保護）

却下。Yorishiro 内の agent が Yorishiro 自身の Rust code を編集すると、自分の変更が引き起こす hot reload で自分のセッションが止まる。これを避けたい動機は正当だが、スキップは目的を達成しない。backend 再起動後に旧 PTY へ再 attach する経路がないため agent は保護されず、残るのは lock を握った残留 sidecar だけになる。導入当日の dev loop で issue #109 と同一の resume 失敗が再発したため、経験的にも棄却された。

### debug build で startup reaper だけ実行する（teardown はスキップ）

却下。結果は一律動作とほぼ同じ（残留 sidecar は次回起動で数秒後に整理される）で、profile 分岐の複雑さに見合う利得がない。in-flight turn が次回起動までのわずかな間だけ取り残された sidecar 内で走り続けるが、再 attach できない以上その成果を回収する手段がない。

### Tauri process の外に session supervisor を置く

将来案として保留。PTY 所有権、IPC、process restart 後の再 attach、crash recovery を正式に扱えるため、自己改修セッションの継続を保証する本命案。今回の sidecar leak 修正としては scope が大きすぎる。

## この決定の implication / 制約

- app 終了は agent session 終了を意味する。app 終了後も作業を継続する正式な background mode ではない。
- 自己改修 workflow（Yorishiro 内の agent が Yorishiro の Rust code を触る）では、hot reload のたびに agent session が終わる。継続性が必要になった時点で session supervisor を設計する。lifecycle の例外を増やす方向では解決しない。
- registry reap は「registry に記録した endpoint がコマンドラインに現れる codex app-server」以外を殺さない。Yorishiro 以外が起動した app-server や PID 再利用先には触れない。
- reaper が安全に停止できない利用中の writer は生かしたままにし、`resume` の active writer error を `fork` へ限定 fallback する。その他の resume error は fallback せず表示する。
- registry への spawn 記録に失敗した場合は、未記録 sidecar を動かし続けず、その場で停止して session 起動を失敗させる。短期の可用性より、crash 後に provenance のない process を残さないことを優先する。
- registry 導入前かつ sidecar 導入後の pre-release / source build が取り残した sidecar は記録がないため、移行用 sweep が別途整理する（v0.6.2 以前の release build は sidecar 自体を spawn しないため対象外）。対象は「binary basename が正確に `codex` で、コマンドラインが `<codex binary> app-server --listen ws://127.0.0.1:<port>` そのもの」「PPID=1」「registry に記録なし」「その process 自身の listen socket に client 接続なし」の全条件を満たす process のみ。update の再起動では旧 build が codex session を開いたまま終了するため、この経路がないと更新直後の `resume --last` が確実に -32600 で失敗する（v0.7.0 で実際に発生）。条件推定による cleanup を常設しないため、全候補の回収を確認した clean pass 後に marker を書き、以後は実行しない。process 一覧を観測できない、client 付き候補がいる、または signal 前後の再検査で候補を安全に回収できない場合は marker を書かず、次回起動で再試行する。TERM / KILL 前には socket 観測の前後で process start time・PPID・command を照合し、候補ごとに最新 registry を再読する。最後の identity 照合と raw PID への signal の間に残る syscall 単位の窓は、macOS に pidfd 相当がないため受け入れる制約とする。

## 関連 reference

- source: `src-tauri/src/lib.rs` (`setup` の startup reaper / `RunEvent::Exit`)
- source: `src-tauri/src/sessions/codex_sidecar_registry.rs`
- source: `src-tauri/src/sessions/pty_session.rs` (`CodexAppServerProcess` / `PtySession::kill`)
- decision: [codex-realtime-voice.md](codex-realtime-voice.md) — session-scoped app-server の所有関係
- decision: [codex-terminal-agent.md](codex-terminal-agent.md) — Codex PTY session の起動契約
- issue: `#109`

## 改訂履歴

- 2026-08-08: reaper で停止できない正当な active writer がいる場合の resume-first / fork fallback を追加。
- 2026-08-08: 初版は build profile で teardown / reaper を分ける案だったが、debug スキップが dev loop 内で issue #109 の resume 失敗を再現したため、公開前に一律動作へ改めた。自己改修セッション保護は session supervisor の future work とする。
