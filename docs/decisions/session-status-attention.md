# Session Status / Attention — タブ単位の観察 read model と「許可待ち」表示

> このファイルは「**各 session（agent / shell）の状態をどう観察し、TabIndicator にどう出すか・特に awaiting-input（許可待ち）をどう検出 / 解除するか**」を考える時に読む。対象：dev / AI。

**Status**: active（partial — Rust OSC133 activity の TS bridge は未配線、§7）
**Last updated**: 2026-06-28

## TL;DR

各 session の「いま何が起きているか」を UI 向けに畳む **observation-only な read model**（`SessionStatusStore`）を持つ。lifecycle / activity / unread / exit に加え、agent の **注意要求（attention）** を集約し、TabIndicator に単一 badge（`start` / `run` / `idle` / `input` / `done` / `failed` / `exited`）として出す。

「許可待ち（`input`）」は cmux 由来の **terminal-native な notification OSC（9/99/777）を受動観察**するのを軸にし、**HTTP の Claude `Notification` hook を first-class な fallback**として併用する。許可待ちは sticky（出力 / focus では消えない）で、**確定入力 or agent の resume hook（stop / prompt）でのみ解除**する。PTY observation-only（[critical-constraints §1](critical-constraints.md)）は一切緩めない。

## 何を決めたか

### 1. host 所有の observation-only read model（環境を変えない）

`SessionStatusStore`（`src/runtime/session-status/`）は session ごとの観察状態を保持する webview-lifetime singleton。PTY へ書かない / session を spawn・switch・close しない。状態は全て派生（再導出可能）で、Rust 由来の lifecycle / activity を「気づく」ための材料に畳むだけ。[loop-presence-layer](loop-presence-layer.md) と同じ「観察の解像度を上げる、orchestrator にはしない」立ち位置。

### 2. activity は PTY 出力 heuristic（OSC133 bridge までの暫定）

TabIndicator が `run` を出せるよう、PTY 出力が来たら `running-command`、出力が `~800ms` 静まったら `idle` に戻す（`markOutput` / `settleOutput`、debounce は Terminal 側 timer）。shell は Rust が OSC133 で activity を持つが TS へ未 bridge（§7）。agent TUI は OSC133 を出さないので、出力 heuristic が両者共通の「動いている」signal になる。`lastActivityAt` だけの変化では notify しない（streaming 中の App 全再描画を防ぐ churn 対策）。

### 3. 許可待ちの観察源：OSC 9/99/777（主・terminal-native）＋ Notification hook（first-class fallback）

cmux の notification ring の正体は、特別な IPC ではなく terminal 出力に流れる **OSC 9 / 99 / 777 を受動的に拾う**こと。Charminal は `terminal-runtime` に `registerOscHandler(9/99/777)` を足し、host が sessionId を stamp して `markAttentionRequest()` に流す（OSC133/633 の隣・既存 infra の延長、PTY write なし）。

ただし OSC 経路は emit 側（hook が `/dev/tty` へ echo）が失敗すると silent に落ちる。そこで **HTTP `/hook/notification` を first-class** にし、hook server が `event:"notification"` で tag → App の poll loop が `markAttentionRequest()` する経路を主たる堅い入口にする。OSC は補助。

### 4. 「attention request」であって「awaiting-input」専用ではない（概念分離）

OSC notification / Notification hook は「許可待ち」だけでなく「turn 完了」等も運ぶ汎用の注意要求。これを Rust 由来の `activity`（idle / running-command / awaiting-input。OSC133 mirror）に混ぜず、**独立した `attention` field**として持つ（[separate-distinct-systems](separate-distinct-systems.md)）。badge 導出は exited > awaiting-input > running > starting > idle の優先順。

### 5. 解除ポリシー：sticky。focus では消さない

- `markActive`（タブを active にする）は **unread のみ解除**し、awaiting-input / attention は維持する。「見るために active にしただけ」で許可待ちを消すのは早すぎる。
- agent の TUI は待機中も再描画し続けるので、`markOutput` / `settleOutput` でも消さない（sticky）。
- 解除するのは 2 経路のみ：
  1. **確定入力**：非 ESC の keystroke（Enter / 文字 / 数字）。マウス報告・focus 報告・矢印などの **ESC 始まり sequence は無視**する（`isAttentionClearingInput`）。これらは agent TUI の mouse tracking / focus reporting で `term.onData` に流入するため、無視しないと「マウスを動かしただけ / フォーカスが変わっただけ」で消える。
  2. **agent resume hook**：`stop`（ターン終了）/ `prompt`（UserPromptSubmit）。マウスクリック approve 等 keystroke で拾えないケースの保険。`PreToolUse` は permission gate と発火が近く早すぎる解除になりうるので採らない。

### 6. attribution と exit の扱い

- OSC 経路は `sessionId` を host-stamp（詐称不可）。HTTP hook 経路は Charminal の session id を持たないので、**agent = main session**を宛先にする（裏タブの agent が許可待ちでも agent タブに出す）。
- `pty-exit` の `recordExit` は **非 main session のみ**。main は auto-respawn するので exit badge を出さない。
- 非 main session は exit しても **即 close しない**（`done` / `failed` を見せ、ユーザーが Cmd+W で閉じる）。

### 7. emit 側は要設定、受信は純粋な出力読み取り

Claude Code は `Notification` hook に (a) HTTP POST と (b) `hook-notify-osc.py`（stdin の `message` を読んで `/dev/tty` に OSC 777 を書く）を仕込む。Codex は OSC notification 設定（`notification_method` 系）で OSC 9 を emit（将来検証）。受信側（registerOscHandler / hook poll）は出力を読むだけ。

## なぜそう決めたか

- **observation-only が核**。許可待ち検出は「観察の解像度」を上げる話で、PTY write / session 駆動には踏み込まない（[critical-constraints §1](critical-constraints.md) / [loop-presence-layer](loop-presence-layer.md)）。
- **両 agent 対応**。OSC は terminal-native で Claude / Codex どちらも emit でき、Notification hook は Claude 専用化を避ける fallback。HTTP first-class は「OSC が tty に書けない」failure に強い。
- **early-clear を避ける**のが実運用上の主因だった。mouse/focus report が `onData` に来るため「入力で解除」が広すぎ、focus 解除も「見ただけで消える」。sticky + 限定解除が正しい挙動。
- **presence over spectacle**。許可待ちは noteworthy（赤系強調）として扱い、全 command には反応しない（[presence-over-spectacle](presence-over-spectacle.md) / [interaction-as-presence](interaction-as-presence.md)）。

## 検討したが却下した代替案

- **focus（markActive）で awaiting-input を解除**：却下。承認前にタブを見ただけで消える。unread 解除に留める。
- **あらゆる `onData` で解除**：却下。mouse tracking / focus reporting の ESC sequence で早期解除される。
- **attention を `activity` に畳む**：却下。OSC133 由来 activity と概念が違い、上書き合戦になる。独立 field にする。
- **HTTP-only / OSC-only**：却下。OSC は emit 失敗が silent、HTTP は session 属性を持たない。両建てで補完する。
- **`PreToolUse` で解除**：却下。permission gate と発火タイミングが近く、解除が早すぎるリスク。
- **非 main session を exit で即 close**：却下。`failed` badge を見る前に消える。

## この決定の implication / 制約

- **PTY observation-only 不変**：notification は出力 stream を読むだけ。`loop_announce` 等と同じ observation channel。
- **要 rebuild / 新 session**：`Notification` hook は session spawn 時に `hooks.json` へ書かれるため、Rust 変更後は再ビルド + agent 再起動が必要。
- **mouse-click approve の残存**：マウスでクリック確定した場合、keystroke 解除に乗らず `stop` hook（ターン終了）まで badge が残る。許容。
- **deferred**：Rust `SessionRegistry` の OSC133 activity（shell の running-command / idle）を TS `SessionStatusStore` に bridge する配線（§2 の heuristic を精密化）。Codex の OSC notification 実機検証。attention の persona reflex / aura 連動（cmux の pane glow 相当）。
- 主な source：`src/runtime/session-status/`（store / `deriveSessionStatusBadge` / `isAttentionClearingInput`）、`src/runtime/terminal-runtime/`（`osc-notification.ts` / `subscribeNotification` / `subscribeUserInput`）、`src/terminal.tsx`、`src/components/TabIndicator.tsx`、`src/App.tsx`（hook poll → markAttentionRequest / clearAttention）、`src-tauri/src/pty.rs`（`Notification` hook + `hook-notify-osc.py` + `/hook/notification` tag）。

## 関連 reference

- decision：[critical-constraints.md](critical-constraints.md) §1、[loop-presence-layer.md](loop-presence-layer.md)、[agent-adapter.md](agent-adapter.md)、[separate-distinct-systems.md](separate-distinct-systems.md)、[presence-over-spectacle.md](presence-over-spectacle.md)、[interaction-as-presence.md](interaction-as-presence.md)、[autonomy-without-disruption.md](autonomy-without-disruption.md)
- philosophy：`docs/philosophy/PHILOSOPHY.ja.md`「観察の境界」「二つの層」
- 外部参考：cmux（manaflow-ai/cmux）— notification ring（OSC 9/99/777 受動観察）、approval 待ち可視化

## 改訂履歴

- 2026-06-28: 初版。SessionStatusStore（観察 read model）+ TabIndicator badge、awaiting-input の OSC/HTTP 二系統入口、sticky + 限定解除（確定入力 / stop・prompt hook、focus・mouse/focus report では消さない）、attribution（OSC=host-stamp / HTTP=agent main）、非 main exit 保持を確定。Rust OSC133 activity の TS bridge は deferred。
