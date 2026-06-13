# Semantic-priority attention

**Status**: active
**Last updated**: 2026-04-26
**Related**: `docs/decisions/critical-constraints.md`、`docs/philosophy/PHILOSOPHY.ja.md`「観察の境界」

---

## 結論（v2 の実態）

v2 attention runtime は **「v1 UX を v2 architecture で担保する」** 設計に収束した。

- **Architecture (v2)**: producer / attention-runtime / resolver / ambient-ui pack の責務分離。`setSourceTarget` による source ごとの管理。priority / confidence / TTL による resolver。
- **UX baseline**: source set / priority / rect 戦略 / aura visual は **v1 reference に揃える**（後述「v1 を真とした理由」参照）。
- **意図的な v1 からの逸脱**: 以下 4 点のみ（後述「v2 の intentional deviation」参照）。

---

## v1 を真とした理由

Phase 1b / 1c のリライトでは、source set を「設計上の改善機会」として捉え、`focused-dom` や `mouse` をノイズとして削減した。結果として Phase 1d 配線直後に v1 UX のリグレッションが発覚し、7 本の fix commit（5ebfd0d〜c0ecb23）で v1 に戻した。

v1 は実 usage を通じて磨かれた基準値であった。Phase 1b / 1c の「意味希薄として cut」という判断は、事前の設計上の推論であり、**実際の UI 体験では valid でなかった**。v2 の価値は「source set の再発明」にあるのではなく、**producer / runtime / resolver の責務分離と型安全な architecture** にある。source set の意味的な再評価は v2 delivery 後に実 usage を見てから行う。

---

## v2 の intentional deviation（v1 との差分）

以下 4 点だけが v2 での意図的な変更。それ以外は v1 と同一。

### 1. `recent-output` を emit しない（v1 からの継続 cut）

v1 では PTY に何か出力されると priority 1 で emit していた。v2 ではこれを **完全に削除**（Phase 1b 時点から）。

- 理由: 「PTY output が来た」は内容問わず発火するため **意味が薄い**。住人が向けるべき視線を稀釈する。
- v1 での priority 1（最弱）という設定自体が「他に見るものがない時だけ」という意味だったが、それは「emit しない」で十分表現できる。

### 2. `sent` / `activate` reasons — 追加後に撤回

B15 で input-cursor の sent（Enter 送信時の pulse）と activate（interactive element の Enter activate 時）を v2 拡張として追加したが、user-prompt-submit hook の発火タイミング問題（B16/B17 参照、`docs/decisions/hook-signals.md`）と production build で xterm.onData("\r") 駆動でも実 visual が出ない問題（B18 撤回）で cost/value が見合わず B18 で撤回。input-cursor は typing のみとなり、v1 の挙動と一致する。

### 3. terminal-region aura を transient 化（commit c0ecb23 — A2+B2 spec）

v1 では diagnostic / file-link 行が viewport にある間は **継続して** emit していた。v2 では **新規行検出 + 3 秒 pulse** に変更。

- 理由: diagnostic aura が永続化すると「typing が見える時間」がなくなり、入力時の存在感が消える。「新しい何かが現れた」という瞬間にだけ反応することで attention の意味を保ちつつ、3 秒後には typing（priority 5）が見える。
- 実装: 前 frame の行テキスト Set と比較し、新規行のみ emit + `setTimeout(3000)` で null clear（commit c0ecb23）。

### 4. typing priority を 3 → 5 に引き上げ（commit c0ecb23 — B2 spec）

v1 では typing は priority 2 相当の低優先だった。v2 では priority 5 に引き上げ。

- 理由: transient 化（A2）と pair。diagnostic が 3 秒で消えた後、priority 5 の typing が見えるようにするための調整。terminal:file-link / focused-dom とも同じ 5 になるため、これら同 priority 間は confidence で tie-break される（typing は confidence=1.0 で最も強い）。

---

## 現在の attention source 一覧（8 source）

各値は producer ファイルの実装値（コメントや定数から読み取った実測値）。

| source | kind | priority | confidence | reason | rect 戦略 | clear 方式 |
|---|---|---|---|---|---|---|
| cursor-attention (mouse) | mouse | 9 | 0.9 | cursor-attention:mouse-click | interactive 要素は要素 rect、それ以外はポインタ座標 ±10px の 20×20 halo | pointerdown で 1〜3 秒 active window を開き、満了で null clear |
| terminal:diagnostic | terminal-region | 8 | 0.7 | diagnostic | 検出行の rect | 新規行検出時 emit + 3000ms pulse (commit c0ecb23) |
| terminal:file-link | terminal-region | 5 | 0.7 | file-link | 検出行の rect | 新規行検出時 emit + 3000ms pulse (commit c0ecb23) |
| tool-diagnostic | terminal-region | 6 | 0.8 | diagnostic | 最終 viewport 行 rect ±6px expand | resolver TTL（hook signal stop / 次の tool-activity none で clear） |
| tool-activity | terminal-region | 4 | 0.72 | tool-reading / tool-writing / tool-running | 最終 viewport 行 rect ±6px expand | tool-activity none / stop hook で clear |
| mcp-tool-request | mcp-ui | 4 | 0.72 | tool-writing (set-ui-state) / tool-reading (その他) | `.ui-pack-container:not(.ambient)` または `.shell-column`（"shell" surface）±8px expand | 1200ms timeout で手動 clear |
| focused-dom | focused-dom | 5 | 0.7 | focus | activeElement bounding rect ±10px expand | rAF poll で focus 変化を検出し null clear |
| input-cursor:typing | input-cursor | 5 | 1.0 | typing | xterm cursor cell rect（拡張なし） | rAF poll（lastUserInputAt gate）+ TTL 2000ms |

**emit しない source（設計的に削除済み）:**

| source | v1 での挙動 | 削除理由 |
|---|---|---|
| `recent-output` | PTY output が来るたびに priority 1 で emit | 内容問わず発火するため意味が薄い。視線の稀釈になる |
| `cursor-position` | マウス移動ごとに emit | click でない単なる移動は意味を持たない（mouse producer は click + active window に限定） |

---

## 適用ガイド

- **新 producer を足すとき**: 「このイベントは住人が**見る価値**があるか」を最初に問う。即答できないなら emit しない。v1 で tested でない source は慎重に扱う。
- **priority 設計**: 高い priority = 「意味が強い（住人が反応すべき）」。同 kind 内の tie-break は confidence で行う。整数に抑え、0.x の細分割はしない。
- **transient vs 定常**: 「新しい何かが現れた瞬間」に反応し「既にそこにある状態」を持続監視しない設計（terminal-region の A2 transient）は、attention の過飽和を防ぐ基本パターン。継続 emit が必要かを毎回問う。
- **producer の clear 責任**: TTL / pulse / event-driven clear の 3 パターン。どれを選ぶかは source の性質による（Enter は単発 event なので producer 側で 600ms pulse を持つ例外）。

---

## Reference

- fix commits: 5ebfd0d (aura visual) / 032700c (mouse active window) / 5581df1 (body triggerCursorAttention) / d0d9ba5 (input-cursor rAF) / fed792c (terminal rAF + bottom-first) / 1560b85 (focused-dom + tool/mcp v1 parity) / c714c27 (ambient-layer z-index) / c0ecb23 (terminal transient + typing priority 5)
- producer 実装: `src/runtime/attention-producers/`（mouse.ts / terminal.ts / input-cursor.ts / tool.ts / mcp.ts / focused-dom.ts）
- Philosophy: `docs/philosophy/PHILOSOPHY.ja.md`「観察の境界」

## 関連 critical constraints

- 「Ambient-ui pack に attention の write 権限を渡さない」(`docs/decisions/critical-constraints.md` §6)
- 「Producer が emit する target には reason field を埋め、aura はそれを style に map する」（`auraVisualForTarget` の責務分離）

---

## 改訂履歴

- 2026-04-26 (B18): sent / activate を v2 deviation から「追加後撤回」に書き換え。source テーブルを 10 → 8 source に更新（input-cursor:sent・input-cursor:activate 行を削除）。
- 2026-04-26: 全面書き直し。Phase 1d 後の 7 本 fix commit（5ebfd0d〜c0ecb23）により v2 は「v1 UX を v2 architecture で担保」する設計に収束したため、「mouse / focused-dom は意味希薄として cut」という旧記述を撤回し実態に合わせた。v2 の intentional deviation 4 点・source テーブル（10 source）・「v1 を真とした理由」section を追加。
- 2026-04-25: 初版作成（Phase 1d-10。旧記述の誤りが後に判明し本日付で全面改訂）。
