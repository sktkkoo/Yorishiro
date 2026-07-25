# Codex realtime voice

**Status**: experimental
**Last updated**: 2026-07-25

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
   TUI の thread を見つけて `thread/realtime/start` の realtime v3 + WebRTC transport を開始

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

## 関連 reference

- `src-tauri/src/sessions/pty_session.rs` — app-server process lifecycle
- `src-tauri/src/sessions/agent_adapter/codex.rs` — `--remote` launch
- `src/runtime/codex-realtime/` — JSON-RPC / WebRTC / lip sync
- `src/title-bar.tsx` — host-owned microphone UI
- [OpenAI Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)
- [critical-constraints.md](critical-constraints.md) §1 PTY observation only
