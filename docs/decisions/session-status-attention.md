# Session Status / Attention — タブ単位の観察 read model と「許可待ち」表示

> このファイルは「**各 session（agent / shell）の状態をどう観察し、TabIndicator にどう出すか・特に awaiting-input（許可待ち）をどう検出 / 解除するか**」を考える時に読む。対象：dev / AI。

**Status**: active（partial — Rust OSC133 activity の TS bridge は未配線、§7）
**Last updated**: 2026-06-28

## TL;DR

各 session の「いま何が起きているか」を UI 向けに畳む **observation-only な read model**（`SessionStatusStore`）を持つ。lifecycle / activity / unread / exit に加え、agent の **注意要求（attention）** を集約し、TabIndicator に単一 badge（`start` / `run` / `idle` / `input` / `done` / `failed` / `exited`）として出す。

「許可待ち（`input`）」は、release 前の体感 latency 対策として **xterm screen buffer 末尾の permission prompt を低遅延 fast path として読む**。agent hook 由来の attention signal と terminal-native な notification OSC（9/99/777）は fallback / 汎用 attention 経路として残す。許可待ちは sticky（出力 / focus では消えない）で、**確定入力、screen 上からの prompt 消失、agent の resume hook（stop / prompt）で解除**する。PTY observation-only（[critical-constraints §1](critical-constraints.md)）は一切緩めない。

現状の Charminal で最も低遅延に検出できるのは、その terminal screen に実際に permission prompt が描かれるケース。hook / OSC だけで安定検出できるのは、Charminal が起動時に hooks / OSC を注入した main agent、またはその terminal session に OSC notification が直接出た場合。shell tab でユーザーが手動起動した `claude` / `codex` の許可待ちを非 main session に正しく attribute する恒久策は、cmux と同じく shell 起動環境に per-session wrapper / shim を入れること（§8）。

## 何を決めたか

### 1. host 所有の observation-only read model（環境を変えない）

`SessionStatusStore`（`src/runtime/session-status/`）は session ごとの観察状態を保持する webview-lifetime singleton。PTY へ書かない / session を spawn・switch・close しない。状態は全て派生（再導出可能）で、Rust 由来の lifecycle / activity を「気づく」ための材料に畳むだけ。[loop-presence-layer](loop-presence-layer.md) と同じ「観察の解像度を上げる、orchestrator にはしない」立ち位置。

### 2. activity は PTY 出力 heuristic（OSC133 bridge までの暫定）

TabIndicator が `run` を出せるよう、PTY 出力が来たら `running-command`、出力が `~800ms` 静まったら `idle` に戻す（`markOutput` / `settleOutput`、debounce は Terminal 側 timer）。shell は Rust が OSC133 で activity を持つが TS へ未 bridge（§7）。agent TUI は OSC133 を出さないので、出力 heuristic が両者共通の「動いている」signal になる。`lastActivityAt` だけの変化では notify しない（streaming 中の App 全再描画を防ぐ churn 対策）。

### 3. 許可待ちの観察源：screen buffer fast path ＋ agent hook / OSC fallback

Claude Code の `Notification` hook は permission prompt 表示から数秒（環境によって 10 秒級）遅れて発火することがある。Charminal 内部の HTTP hook server → Tauri event → App は即時化済みなので、残るラグは upstream hook 発火タイミングにある。`PermissionRequest` hook は auto-allowed tool でも発火しうるため、「許可待ち」判定の fast path には使わない。

そこで `terminal-runtime.readScreenTailText()` で xterm screen buffer 末尾を DOM geometry 非依存に読み、`screen-attention-detector` が Claude Code / Codex / generic な permission prompt 文面を検出する。Terminal は PTY chunk 後に短く debounce（約 80ms）して screen scan し、検出したら `markScreenAttentionRequest()` する。これが release 時点の `input` badge の主経路。非 active tab でも xterm buffer は保持されるため、detached / hidden 中の session でも読める。

Charminal の受信側は `terminal-runtime` の `registerOscHandler(9/99/777)` で terminal 出力に流れた notification OSC も拾える。これは host が sessionId を stamp できるため attribution は強い。ただし OSC は「その session の PTY に実際に書かれた場合」しか見えず、agent の permission state を汎用に推定する仕組みではない。

agent hook は fallback / 汎用 attention 経路。Claude `Notification` hook など agent が明示的に「ユーザー注意要求」を出すイベントを、HTTP `/hook/notification` などの host 経路で `markAttentionRequest(source:"hook")` に流す。OSC は同一 terminal への lightweight signal として残すが、emit 側（hook が `/dev/tty` へ echo）が失敗すると silent に落ちるため、hook 経路の代替ではなく補助。

### 4. 「attention request」であって「awaiting-input」専用ではない（概念分離）

OSC notification / Notification hook は「許可待ち」だけでなく「turn 完了」等も運ぶ汎用の注意要求。これを Rust 由来の `activity`（idle / running-command / awaiting-input。OSC133 mirror）に混ぜず、**独立した `attention` field**として持つ（[separate-distinct-systems](separate-distinct-systems.md)）。badge 導出は exited > awaiting-input > running > starting > idle の優先順。

### 5. 解除ポリシー：sticky。focus では消さない

- `markActive`（タブを active にする）は **unread のみ解除**し、awaiting-input / attention は維持する。「見るために active にしただけ」で許可待ちを消すのは早すぎる。
- agent の TUI は待機中も再描画し続けるので、`markOutput` / `settleOutput` でも消さない（sticky）。
- 解除するのは 3 経路のみ：
  1. **確定入力**：非 ESC の keystroke（Enter / 文字 / 数字）。マウス報告・focus 報告・矢印などの **ESC 始まり sequence は無視**する（`isAttentionClearingInput`）。これらは agent TUI の mouse tracking / focus reporting で `term.onData` に流入するため、無視しないと「マウスを動かしただけ / フォーカスが変わっただけ」で消える。
  2. **screen prompt 消失**：screen fast path 由来の attention は、次の scan で prompt が見えなくなったら解除する。マウスクリック approve 等、keystroke 解除に乗らないケースの主経路。
  3. **agent resume hook**：`stop`（ターン終了）/ `prompt`（UserPromptSubmit）。screen scan が取りこぼした時の保険。`PreToolUse` は permission gate と発火が近く早すぎる解除になりうるので採らない。

screen fast path が出した attention は hook / OSC より権威を持つ。prompt が画面に見えている間に遅れて来た hook notification で source を上書きしない。またユーザー入力 / screen 消失で解除した直後に遅れて来た hook / OSC は短時間（既定 10 秒）抑止し、古い通知で `input` が復活しないようにする。

### 6. attribution と exit の扱い

- OSC 経路は `sessionId` を host-stamp（詐称不可）。HTTP hook 経路は Charminal の session id を持たないので、**agent = main session**を宛先にする（裏タブの agent が許可待ちでも agent タブに出す）。
- `pty-exit` の `recordExit` は **非 main session のみ**。main は auto-respawn するので exit badge を出さない。
- 非 main session は exit しても **即 close しない**（`done` / `failed` を見せ、ユーザーが Cmd+W で閉じる）。

### 7. emit 側は要設定、受信は純粋な観察

Claude Code は `Notification` hook に (a) HTTP POST と (b) `hook-notify-osc.py`（stdin の `message` を読んで `/dev/tty` に OSC 777 を書く）を仕込む。Codex は hook / notification API の実機確認が必要。どちらも受信側（registerOscHandler / hook poll）は観察だけで、PTY へ書かない。

### 8. 手動起動 shell agent と cmux 調査（2026-06-28）

結論：現状の Charminal は、main agent 以外の shell でユーザーが手動起動した `claude` / `codex` の許可待ちを安定検出できない。検出できるのは、agent がその terminal に notification OSC を直接吐いた場合だけで、`sessionId` 付きの hook signal は注入されていない。特に HTTP hook fallback は現在 main agent 前提なので、非 main shell agent に attribute できない。

cmux（`manaflow-ai/cmux`、調査 snapshot `05c03cf5ac3640485f53623731ea416d642e8007`）は、端末画面や TUI 文字列を読んで推定していない。仕組みは次の組み合わせ。

- terminal surface 起動時に `CMUX_SURFACE_ID` / `CMUX_WORKSPACE_ID` / `CMUX_SOCKET_PATH` を環境変数として入れる。source: [TerminalSurface+StartupEnvironment.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/Packages/macOS/CmuxTerminal/Sources/CmuxTerminal/Spawn/TerminalSurface%2BStartupEnvironment.swift#L44-L62)
- surface ごとの一時ディレクトリに `claude` shim を作り、同じ directory に sibling `codex` shim も置く。shell の `PATH` 先頭へ prepend するので、ユーザーが普通に `claude` / `codex` を打つだけで cmux wrapper を通る。source: [StartupEnvironment.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/Packages/macOS/CmuxTerminal/Sources/CmuxTerminal/Spawn/TerminalSurface%2BStartupEnvironment.swift#L101-L180), [RuntimeSurfaceCreation.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/Packages/macOS/CmuxTerminal/Sources/CmuxTerminal/Surface/TerminalSurface%2BRuntimeSurfaceCreation.swift#L158-L180)
- hook command は `CMUX_SURFACE_ID` と live socket がある時だけ cmux CLI に送る。外部 terminal / stale socket / opt-out では no-op で real binary を exec する。source: [CMUXCLI+AgentHookDefinitions.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/CLI/CMUXCLI%2BAgentHookDefinitions.swift#L455-L466), [cmux-codex-wrapper](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/Resources/bin/cmux-codex-wrapper#L255-L265)
- Codex は wrapper が per-invocation で `--enable hooks` / `--dangerously-bypass-hook-trust` / `-c hooks.Event=...` を差し込み、`SessionStart` / `UserPromptSubmit` / `Stop` / `PreToolUse` / `PostToolUse` / `PermissionRequest` を cmux へ送る。`PermissionRequest` は `notification` subcommand に紐づく。source: [CMUXCLI+CodexFireAndForgetHooks.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/CLI/CMUXCLI%2BCodexFireAndForgetHooks.swift#L10-L17), [cmux-codex-wrapper](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/Resources/bin/cmux-codex-wrapper#L318-L355)
- persistent hook install も持つ。Codex では `cmux hooks setup --agent codex` が `~/.codex/hooks.json` を触る経路で、custom launcher / subrouter が PATH wrapper を bypass する場合の保険。source: [CMUXCLI+AgentHookDefinitions.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/CLI/CMUXCLI%2BAgentHookDefinitions.swift#L156-L177), [AutomationSection.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/Packages/macOS/CmuxSettingsUI/Sources/CmuxSettingsUI/Sections/AutomationSection.swift#L229-L265)
- Feed classifier は event semantics を分ける。Claude `PermissionRequest` は actionable approval、Codex `PermissionRequest` は Codex 自身の reviewer 前に走るため telemetry 扱いにしている。source: [FeedEventClassifier.swift](https://github.com/manaflow-ai/cmux/blob/05c03cf5ac3640485f53623731ea416d642e8007/CLI/FeedEventClassifier.swift#L163-L190)

Charminal で同等にするなら、非 main shell session の spawn 時に `CHARMINAL_SESSION_ID` / hook endpoint or socket / bundled CLI path を環境へ入れ、per-session temp directory に `claude` / `codex` shim を置いて `PATH` 先頭へ prepend する。wrapper は outside Charminal / stale endpoint / opt-out では必ず real binary に pass-through し、inside Charminal だけ hooks を注入して session id 付き signal を backend に送る。global な `~/.claude` / `~/.codex` を触る persistent hook install は、custom launcher 対応用の明示 opt-in に留める。

## なぜそう決めたか

- **observation-only が核**。許可待ち検出は「観察の解像度」を上げる話で、PTY write / session 駆動には踏み込まない（[critical-constraints §1](critical-constraints.md) / [loop-presence-layer](loop-presence-layer.md)）。
- **低 latency を優先**。permission / notification hook は意味的には強いが、Claude Code では実 prompt 表示から数秒遅れることがある。release で「気づける terminal」を作るには、prompt が最初に現れる screen buffer を fast path にするのが最も実用的。
- **両 agent 対応**。screen buffer は agent が最終的に terminal に prompt を描く限り Claude / Codex どちらでも効く。OSC は terminal-native な補助信号として agent 種別をまたげるが、非 main shell agent の恒久的 attribution には wrapper / hook 注入が必要。
- **early-clear を避ける**のが実運用上の主因だった。mouse/focus report が `onData` に来るため「入力で解除」が広すぎ、focus 解除も「見ただけで消える」。sticky + 限定解除が正しい挙動。
- **presence over spectacle**。許可待ちは noteworthy（赤系強調）として扱い、全 command には反応しない（[presence-over-spectacle](presence-over-spectacle.md) / [interaction-as-presence](interaction-as-presence.md)）。

## 検討したが却下した代替案

- **focus（markActive）で awaiting-input を解除**：却下。承認前にタブを見ただけで消える。unread 解除に留める。
- **あらゆる `onData` で解除**：却下。mouse tracking / focus reporting の ESC sequence で早期解除される。
- **attention を `activity` に畳む**：却下。OSC133 由来 activity と概念が違い、上書き合戦になる。独立 field にする。
- **HTTP-only / OSC-only**：却下。OSC は emit 失敗が silent、HTTP は session 属性を持たない限り main agent に寄ってしまう。両建てにしつつ、非 main は wrapper で sessionId を注入する。
- **`Notification` hook を low-latency 入口にする**：却下。Charminal 内部配信を immediate にしても hook 自体が数秒遅れて発火するため、`input` badge の体感 latency を解決しない。
- **`PermissionRequest` hook を low-latency 入口にする**：却下。auto-allowed tool でも発火しうるため、許可待ちでない tool use を `input` と誤検出する。
- **`PreToolUse` で解除**：却下。permission gate と発火タイミングが近く、解除が早すぎるリスク。
- **非 main session を exit で即 close**：却下。`failed` badge を見る前に消える。

## この決定の implication / 制約

- **PTY observation-only 不変**：notification は出力 stream を読むだけ。`loop_announce` 等と同じ observation channel。
- **要 rebuild / 新 session**：`Notification` hook は session spawn 時に `hooks.json` へ書かれるため、Rust 変更後は再ビルド + agent 再起動が必要。
- **手動 shell agent は screen fast path の範囲で対応**：`claude` / `codex` を shell tab で手動起動しても、prompt が terminal screen に出れば `input` は検出できる。ただし hook 由来の structured event / sessionId 付き attribution / non-visible semantic events までは得られない。cmux 型の per-session PATH shim は恒久策として deferred。
- **screen 文面 heuristic**：agent UI 文面変更に弱い。`screen-attention-detector` は純粋関数 + test で保護し、Claude / Codex の実 UI に合わせて調整する。
- **deferred**：Rust `SessionRegistry` の OSC133 activity（shell の running-command / idle）を TS `SessionStatusStore` に bridge する配線（§2 の heuristic を精密化）。Codex hook / notification 実機検証。shell session 用 `claude` / `codex` wrapper。attention の persona reflex / aura 連動（cmux の pane glow 相当）。
- 主な source：`src/runtime/session-status/`（store / `screen-attention-detector` / `deriveSessionStatusBadge` / `isAttentionClearingInput`）、`src/runtime/terminal-runtime/`（`readScreenTailText` / `osc-notification.ts` / `subscribeNotification` / `subscribeUserInput`）、`src/terminal.tsx`、`src/components/TabIndicator.tsx`、`src/App.tsx`（`hook-signal` event / fallback poll → markAttentionRequest / clearAttention）、`src-tauri/src/pty.rs`（`Notification` hook + `hook-notify-osc.py` + `/hook/notification` tag + immediate Tauri emit）。

## 関連 reference

- decision：[critical-constraints.md](critical-constraints.md) §1、[loop-presence-layer.md](loop-presence-layer.md)、[agent-adapter.md](agent-adapter.md)、[separate-distinct-systems.md](separate-distinct-systems.md)、[presence-over-spectacle.md](presence-over-spectacle.md)、[interaction-as-presence.md](interaction-as-presence.md)、[autonomy-without-disruption.md](autonomy-without-disruption.md)
- philosophy：`docs/philosophy/PHILOSOPHY.ja.md`「観察の境界」「二つの層」
- 外部参考：cmux（manaflow-ai/cmux）— notification ring / approval 待ち可視化。agent approval 検出は公開実装上、OSC 推定ではなく surface env + PATH shim + agent hooks + socket/feed が中心（§8）。

## 改訂履歴

- 2026-06-28: 初版。SessionStatusStore（観察 read model）+ TabIndicator badge、awaiting-input の OSC/HTTP 二系統入口、sticky + 限定解除（確定入力 / stop・prompt hook、focus・mouse/focus report では消さない）、attribution（OSC=host-stamp / HTTP=agent main）、非 main exit 保持を確定。Rust OSC133 activity の TS bridge は deferred。
- 2026-06-28 rev.2: `input` 表示の数秒〜10 秒級ラグを受け、HTTP hook server → App を polling only から **Tauri event `hook-signal` immediate + polling fallback** に変更。hook server は connection ごとに処理し、read timeout を持つ。decision 本文に反映。
- 2026-06-28 rev.3: polling fallback が古い notification を再処理して `input` を復活させうる問題を受け、Rust hook server が `_charminal_seq` を stamp、App が seq で immediate/polling の重複を dedup する仕様を追加。
- 2026-06-28 rev.4: cmux 公開実装を再調査し、「agent approval 検出 = OSC 受動観察中心」という前提を修正。cmux は surface env + per-surface PATH shim + wrapper-injected hooks + socket/feed で手動起動 `claude` / `codex` を attribute する。Charminal の非 main shell agent 検出は wrapper / hook 注入が必要、と明記。
- 2026-06-28 rev.5: Claude `Notification` hook 自体の発火遅延に対し、xterm screen buffer 末尾を読む `readScreenTailText` + `screen-attention-detector` を `input` badge の low-latency primary path に変更。screen 由来 attention を hook / OSC より権威化し、解除直後の late hook / OSC resurrection を抑止する仕様を追加。
