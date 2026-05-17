# Input prefill boundary — pack/AI に任意テキスト書込み API を露出しない

> このファイルは「**pack / AI が端末入力欄にテキストを入れたい時、PTY write 境界をどう守るか**」を考える時に読む。対象：dev / AI。

**Status**: active（決定確定 / (A) verb 実装は pending、(B) は既存実装）
**Last updated**: 2026-05-18

## TL;DR

pack/AI に「任意テキストを入力欄/PTY に書く」API は型ごと露出しない（[`critical-constraints.md`](critical-constraints.md) §1 維持）。代わりに 2 経路のみ：

- **(A) 固定文字列 verb**：Charminal/bundled 所有の固定文字列テーブルを引く enumerated verb を SDK + MCP に対称公開。pack/AI は文字列を選べず verb 名を呼ぶだけ。
- **(B) Terminal Reference Marker（既存機構）**：write 経路は固定形 token `[#TermN]`（host 採番、user の Cmd+click gesture でのみ mapping 生成）、可変内容は MCP read tool で AI が要求時に解決（observation channel）。

これにより [`mcp-trust-tiers.md`](mcp-trust-tiers.md)「PTY 系 tool は L1+L2+L3+L4 が揃うまで全 tier 禁止」を精緻化：安全 subset（(A) 固定 verb / (B) 固定 token）は今出せる。任意 `terminal_prefill` / `write_terminal_input` は依然禁止。

## 何を決めたか

- 設定画面は **pack のまま**。「基盤以外はなんでも触れる」は Charminal の主張。問題は pack であることではなく、pack 層が **Tauri IPC（`pty_write`）を直叩き**していること（`bundled-packs/ui/charminal-settings/ui.tsx` が `src/bindings/tauri-commands` から `ptyWrite` を相対 import）。
- **(A) 固定文字列 verb**：pack に露出する SDK は `write(text: string)` ではなく「Charminal 定義の固定アクションを呼ぶ verb」。型に任意文字列が通る口が無い＝注入が起こりようがない。charminal-settings の "ショートカット変更" button はこれに乗る（payload は元々 localized 固定 `/charm:...` 文字列なので**機能ロスゼロ**）。
- **固定文字列テーブルは host/bundled (Tier 1) 所有**。user pack は**既存エントリの参照のみ**、テーブルへの登録は不可。登録を許すと*登録時に pack がバイトを選ぶ*ので「呼び出し時は固定」でも実質任意注入になり leak が裏口から復活する。
- (A) verb は**改行を付けず人間が Enter**（テーブルが reviewed でも cheap な多層防御、現状挙動と一致）。
- **Symmetry**：(A) verb は SDK (`ctx.*`) と MCP tool に同じものを公開（CLAUDE.md「Symmetry principle」）。MCP 側も任意注入できず固定 verb だけ。
- **(B)** は既存 Reference Marker 機構を維持。入力欄に入るのは固定形 token `[#TermN]` のみ、可変な実テキストは MCP の resolve tool（read）で AI が要求時に取得。pack/AI は mapping を作れず（user の Cmd+click gesture のみが生成）、capture 機構は host UI affordance であって pack 能力ではない。

## なぜそう決めたか

- `critical-constraints.md` §1：pack/persona が PTY に書けると Claude の judgment を構造的に hack できる。固定 verb は pack がバイトを選べないので注入面が**構造的に存在しない**。「守る」のではなく「面を作らない」。
- `mcp-trust-tiers.md` の 4 層防御がこの設計で縮退する：
  - **L1（character class validation）**：実行時 untrusted 入力が無い → 固定文字列テーブルを build 時に 1 回 review するだけ。backspace 偽装 / ANSI / bidi は攻撃者がバイトを選べない以上発生しない。
  - **L4（social engineering）**：挿入されうる文字列は有限で Charminal が著者。テーブルに footgun が無いか見るだけ。攻撃者制御の無限集合 → host 制御の有限集合。
  - **L2**：verb 呼び出しに rate limit を素直に適用。
  - **L3**：「どの tier/pack がどの verb を呼べるか」は残るが、最悪ケース（任意注入）が消えて軽量。
- **(B) が leak を作らない理由**：可変内容は **read/observation 経路**を通り、write 経路には**固定形 token のみ**乗る。任意内容は PTY write 経路を一切通らない（先の ReferenceMarker 監査結論を継承）。
- cognitive-load lens：runtime sanitizer + composer UI + anti-habituation UX という層を、固定テーブル + enumerated verb に縮める（読者が追う layer を減らす）。

## 検討したが却下した代替案

- **raw `pty_write` 直 import のまま（現状 = leak）**：SDK/IPC 境界が慣習でしかないことを露呈、user pack も同じことをできてしまう前例。却下。
- **任意テキスト + sanitize の composer 案（誤解版、2026-05-18 に revert 済み）**：注入面を作って sanitize で守る形。L1〜L4 を全部背負う。固定 verb の安全 subset で実 use case（shortcut）が足りるなら不要。却下。
- **user pack が固定文字列を登録できる拡張**：登録時に pack がバイトを選ぶ＝実質任意注入で leak 裏口復活。却下（将来要望が来ても任意注入の再来として別途厳密設計が要り、安易に開けない）。

## この決定の implication / 制約

- pack/AI 経路が任意テキストを PTY に書けないことが**型レベルで保証**される（SDK は enumerated verb / 固定 token のみ公開、`write(string)` を公開しない）。§1 はこの primitive 追加後も成立。
- (A) テーブルは bundled に閉じる。user pack 拡張は任意注入の再来なので別途厳密設計が前提。
- (B) の resolve 内容は秘密を含みうる（画面に出ていた物）。**Tier 3（外部 client）では sensitive-read 扱い**で blanket default-open にしない。→ 2026-05-18 実施済み：`mcp-trust-tiers.md` に Sensitive-read 行を分離 + 不変条件（実装検証済み）+ 前向きガード（user-pointed selection 限定、AI 任意 region/scrollback を生やさない）を記録。
- (B) の不変条件（mapping は host-private + user gesture のみ生成 / token は固定形 host 採番 / resolve は read-only）は 2026-05-18 にコードで検証済み。コード変更不要。詳細は `mcp-trust-tiers.md`「Terminal reference の不変条件」。
- **interim**：(A) verb 実装前でも、charminal-settings の leak は「`ptyWrite` 直 import を外し host backed の固定文字列 helper に差し替え」で閉じられる（OSS ブロッカー回避）。interim を恒久化しない。
- `mcp-trust-tiers.md` の leak 元記述（`TerminalPromptButton` が `pty_write` を呼ぶ）は **誤同定**。実体は `charminal-settings/ui.tsx` の `ptyWrite` 直 import。`src/sdk/components/terminal-prompt-button.tsx` は SDK barrel 未 export・未使用のデッドコードで leak 経路ではない。当該 doc を訂正する。

## 関連 reference

- leak 実体: `bundled-packs/ui/charminal-settings/ui.tsx:22`（`import { ptyWrite }`）, `:535`（呼び出し）
- (B) 実体: `src-tauri/src/mcp/tools.rs:494`（reference resolve tool）, `src/runtime/charminal-mcp/tool-handlers.ts:244`（`getTerminalReferences()`）
- host Tier 1 の正しい側: `src/App.tsx:1250`（初回 tutorial prefill、host 自身）
- IPC: `src-tauri/src/lib.rs:243`（`pty_write` command）, `src/bindings/tauri-commands.ts:145`（`ptyWrite` binding）
- 未使用デッドコード: `src/sdk/components/terminal-prompt-button.tsx`（barrel 未 export）
- 決定境界: [`critical-constraints.md`](critical-constraints.md) §1、[`mcp-trust-tiers.md`](mcp-trust-tiers.md)「PTY 系 tool の扱い」
- 思想: `docs/philosophy/SELF_REFERENTIAL_MCP.ja.md`「経路の有無が境界になる」「対称性」、`docs/philosophy/INHABITED_CHARACTER_INTERFACE.ja.md`「観察の境界」

## 改訂履歴

- 2026-05-18: 初版（確定版）。誤解版 composer 決定（任意テキスト + 人間 commit）を revert した上で、(A) 固定文字列 verb + (B) 既存 Reference Marker の 2 経路に確定。任意テキスト書込み API は不在を維持。mcp-trust-tiers の PTY-prefill 保留条項を安全 subset 分だけ精緻化、leak 元誤同定の訂正を記録。
