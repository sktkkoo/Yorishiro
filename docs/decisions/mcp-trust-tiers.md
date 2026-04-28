# MCP trust tiers

> このファイルは「**Charminal の MCP server / client の trust 階層と、各 tier がどの tool を呼べるか**」を考える時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-04-27

## TL;DR

Charminal の MCP は 3 つの trust tier を持つ：

| Tier | 主体 | 操作の扱い | tool access |
|---|---|---|---|
| **Tier 1** | host runtime / bundled pack | 信頼 | 全 tool 直接 |
| **Tier 2** | 住人（user's Claude Code session） | user の手と等価 | 全 tool、destructive 操作のみ approval |
| **Tier 3** | 外部 MCP client / community pack | untrusted | [`pack-execution-classes.md`](pack-execution-classes.md) の capability boundary を全適用 |

PTY 系 tool（`terminal_prefill` / `write_terminal_input` 等）は **当面全 tier で禁止**。安全性（whitelist validation + length cap + trust tier gate + content layer の social engineering 対策）が integrated に揃うまで開放しない。

## Philosophy alignment

trust tier は技術的な access control だが、Charminal philosophy の 3 つの原則を **構造として実装する** 役割も担う：

### 1. 「触れるものと、触れないもの」の精緻化

`docs/philosophy/CHARMINAL.md` 「触れるものと、触れないもの」は、固い核（Rust IO 層 + TS runtime / SDK / core primitive）と生きた表層（user pack、`/charm` 経由の AI 編集）を分けた。

trust tier はこれを **動作主体の側から** 精緻化する：

- Tier 1 = 核と表層を作る側（Charminal 公式）
- Tier 2 = 表層を user / AI が共に育てる側（住人と user）
- Tier 3 = community pack / 外部 client が表層に届く範囲（許可された capability のみ）

「核は触れない、表層は触れる」が pack 配布の側面、「誰がどう触れるか」が tier の側面。両者は直交し、二軸で安全モデルを構成する。

### 2. 「観察の境界」の延長

`docs/philosophy/INHABITED_CHARACTER_INTERFACE.md`「観察の境界」は、Charminal が Claude Code の reasoning loop に書き込まないことを境界として引いた。PTY write API は型としても存在しない。

self-referential MCP は「住人が自身の身体と環境を操作する」を実装するが、上記境界は **継承する**。「住人は自分の家を整える、しかし user の作業や Claude Code の思考には踏み込まない」── trust tier は書き込み可能領域（住人の身体 + 環境 + Charminal 内部）と不可侵領域（user の作業ファイル、Claude Code の judgment loop）を構造的に分離する道具。

このため PTY 系 tool は当面全 tier で禁止（後述）。

### 3. 「住人が住人でいる足場」を保つ

`docs/philosophy/CHARMINAL.md`「壊さないこと」は、user の積み重ねた pack / 設定 / 関係を破壊しない態度を philosophy として引き受けた。

trust tier では：

- destructive operation（pack install / disable / config 根幹変更）は **Tier 2 でも user 介在必須**
- audit log で全 tier の操作履歴を残す（後で振り返って取り消せる、M23「可逆性の確保」を実装側で支える）
- Tier 3 の操作は default deny、各 tool の grant を user が明示

「住人が user の手で育ったものを勝手に壊さない」境界が、trust tier 上の approval 線として現れる。

---

## Why tiers

self-referential MCP は user / 住人 / 外部の 3 surface が同じ tool 体系を共有する設計（`Charminal-design-record/specs/2026-04-17-self-referential-mcp.md` M15「機能拡張の単一の経路」/ M17「ユーザー操作と住人操作の対称性」）。

しかし「全 surface が等しく全機能を呼べる」設計は安全モデルが破綻する：

- 住人が destructive 操作（pack install、config 全消し）を user 知らずに実行
- 外部 MCP server が住人を経由して Charminal 内部 MCP に逆 access
- pack-execution-classes が community pack に対して引いた capability boundary が MCP 経由で迂回

なので **trust tier で gate する**。同じ tool を呼ぶ surface でも、tier が違えば approval / capability が違う。

## Tier 定義

### Tier 1: Host runtime / bundled pack

- Charminal core (`src/`、`src-tauri/`、`bundled-packs/`)
- bundled persona / scene / effect / harness / ui pack

特徴：

- Charminal 公式の責任で書かれた code
- 全 MCP tool 直接 access
- approval / audit log は不要（ただし dev log には残す）
- 「神経の張り巡らされた家」モデルの中心

### Tier 2: 住人（user's Claude Code session）

- user 自身が起動した Claude Code（または同等 AI）を経由する MCP client
- user の Charminal 内 terminal で動作している場合が default

特徴：

- **user の手と等価**として扱う（user が許した AI、責任は user）
- cosmetic operation は approval-less
  - VRM 表情 / 姿勢 / 視線（`set_expression`, `set_pose`, `set_gaze`）
  - Scene effect（`dispatch_effect` で花火 / 手紙 / shake 等）
  - Camera / lighting（`set_camera`, `set_lighting`）
  - Ambient sound（volume 等、scene audio 実装後）
  - VRM body の view 上の調整（永続化しない一時操作）
  - Read tool 全般（`get_state`, `list_packs`, `list_personas` 等）
- Destructive operation は **user 介在必須**（明示的 approval UI を経由）
  - pack install / disable / enable
  - config の根幹変更（`set_terminal_agent`, `set_primary_persona`, `set_active_scene`, `set_vrm` 等の永続化）
  - ファイル書き込み（`/charminal:charm` 経由の pack 編集等）
  - PTY 系 tool 全般（後述、現状全 tier で禁止）
- 判定基準：「user が後で気付いて怒る可能性があるか」
  - 怒らない（巻き戻せて、関係を壊さない）= cosmetic、approval-less
  - 怒る（取り消せても時間 / 関係 cost が大きい）= destructive、approval 必須
- audit log は **常に**残す（cosmetic でも記録、可逆性のため）
- 「夜中に照明を変える」は OK、「夜中に primary persona を勝手に切替える」は user 介在

### Tier 3: 外部 MCP client / community pack

- 別 process / 別マシンの MCP client（多 Charminal 連携、外部 script、untrusted community pack の延長）
- 別 process の AI agent（user の手の届かないところで動く）

特徴：

- pack-execution-classes の capability boundary を全適用
- manifest permissions / allowlist / per-tool approval / rate limit / audit log
- read tool は default 開放、write tool は default deny
- 接続時に tool 一覧を snapshot、後から増えたら user 確認
- 各 tool の grant は明示的に user approval

## Tool category 分類

各 MCP tool は以下のいずれかに属する：

| Category | 例 | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|---|
| **Read** | `get_state`, `list_packs`, `list_personas`, `list_scenes` | ✅ | ✅ | ✅ default |
| **Self-write**（住人の身体・環境） | `set_expression`, `dispatch_effect`, `set_camera`, `set_lighting` | ✅ | ✅ | capability gated |
| **Charminal-write**（config） | `set_primary_persona`, `set_active_scene`, `set_terminal_agent`, `set_vrm` | ✅ | ✅ | manifest gated, default reject |
| **Pack-write**（install / disable） | `install_pack`, `disable_pack`, `enable_pack` | ✅ | user approval 必須 | reject by default |
| **Terminal-write**（PTY 系） | `terminal_prefill`, `write_terminal_input` etc. | **禁止** | **禁止** | **禁止** |
| **System-write**（exec / fs / net） | (harness 経由のみ) | bundled harness のみ | 経由のみ | isolated-js + permissions |

## PTY 系 tool の扱い（重要）

**当面、全 tier で禁止する。**

理由：

- pack-execution-classes は「PTY write API は存在しないまま維持する」を Charminal 哲学の核として明示（`docs/philosophy/INHABITED_CHARACTER_INTERFACE.md`「観察の境界」、revelation 3.13 / 3.18）
- self-referential MCP の体験は「住人が user の reasoning loop を hijack しない」前提で成立する
- `terminal_prefill` 風の例外を設けるには **複数層の防御が integrated に揃う必要**。一つでも欠けると PTY write 禁止の核が崩れる

### 必要な防御層

#### L1: Character class validation（whitelist 方式）

```
allow:
  - printable Unicode (Unicode カテゴリ L*, M*, N*, P*, S*, Zs)
  - 半角空白 (U+0020)、全角空白 (U+3000)

reject:
  - C0 control chars (U+0000 〜 U+001F、ESC / TAB / BS / LF / CR 全て含む)
  - DEL (U+007F)
  - C1 control chars (U+0080 〜 U+009F)
  - LINE SEPARATOR (U+2028)、PARAGRAPH SEPARATOR (U+2029)
  - ZERO WIDTH SPACE / JOINER (U+200B〜U+200D)
  - bidi override (U+202A〜U+202E、U+2066〜U+2069)
```

`\n` / `\r` 禁止だけでは：

- backspace / DEL による視覚偽装（"echo hello\x7f\x7f\x7f rm -rf ~" → 表示は "rm -rf ~"）
- ANSI escape による cursor 操作 / OSC 52（clipboard 書き込み）/ window title 変更 / alternate screen
- bracketed paste mode 強制終了（`\x1b[201~` で paste/typed 区別を欺く）
- C0 control chars（Ctrl-D, Ctrl-V 等）による readline shortcut 悪用

これらが全て通り抜けるので不十分。

#### L2: Length cap + rate limit

- 200〜500 chars cap
- per-tier rate limit
- flood / DoS 対策

#### L3: Trust tier gating

- Tier 3（外部 client）は default deny、明示的 capability declaration が要る
- Tier 2 でも user-visible な pre-fill display を経由（content social engineering 対策）
- Tier 1 のみ自動許可

#### L4: Content layer の social engineering 対策

L1〜L3 を全部通っても、文字列内容そのもので user を騙せる：

```
pre-fill: "/charminal:charm 設定をリセット"
```

文字 class validation は通る、destructive command。user が惰性で Enter → 設定全消し。

これは technical validation では防げない。必要なのは：

- pre-fill 内容の **user-visible display window**（pre-fill された内容を user が確認してから Enter する UI）
- pre-fill display の自動 dismiss 防止（ESC で dismiss、Tab で focus 等の標準 affordance）
- audit log で pre-fill 履歴を user が振り返れる経路

### 解禁の前提

L1 + L2 + L3 + L4 が全て揃うまで、PTY 系 tool は registry / SDK のいずれにも出さない。

### 既存 `bundled-packs/ui/charminal-settings/TerminalPromptButton` の扱い

bundled-settings の "ショートカットを変更" button は内部的に `pty_write` を呼ぶが、これは **MCP tool ではない** ── bundled UI pack 内の Tier 1 行動として、user が click した時のみ pre-fill する。

ただし上記 trust tier 整理が固まるにつれ、TerminalPromptButton 自体も将来的に削除候補となる。理由：

- pack-execution-classes の "PTY write API は存在しないまま維持" 条項と整合させるため
- bundled-settings の SDK leak（`ptyWrite` を `src/bindings/tauri-commands` から直接 import する path）を解消するため
- 同等の UX が `/charm` command の自然な発話で代替可能

具体的な削除タイミングは別 thread で議論する。

## pack-execution-classes との接続

| 観点 | pack-execution-classes | mcp-trust-tiers (本文書) |
|---|---|---|
| 対象 | 配布 pack の JS 実行 | MCP server / client surface |
| 主体 | host vs guest pack | host vs MCP client |
| 境界モデル | `executionClass`（declarative / isolated-js / trusted-main-thread-js） | trust tier（1 / 2 / 3） |
| 共通の capability framework | manifest permissions / allowlist / approval / rate limit / audit log |

community pack が MCP tool を呼ぶ shape は両文書の交点に立つ。具体例：

- isolated-js pack が MCP tool を呼ぶ ── pack の `executionClass` で sandbox + MCP の trust tier で capability gate、二重防御
- 外部 MCP server を install ── community pack を install するときと同じ permissions diff / hash chain / review chain を通す
- 多 Charminal 接続 ── 相手 Charminal の tool 一覧をペアリング時に snapshot、後から増えたら user 確認

### 外部 MCP server install の framework

外部 MCP server（他の VRM ライブラリ、エフェクトツール、音楽ツール等）を Charminal に接続する場合、その server が公開する tool 群は **Tier 3 として扱う**。具体的な install / 接続フローは pack-execution-classes の review chain を流用：

1. **登録時の snapshot**:
   - 外部 server 接続情報 (endpoint URL / spawn command) を `~/.charminal/mcp-servers.json` 等に記録
   - 接続成功直後に server が公開する tool 一覧を snapshot（tool name, schema, description, hash）
   - snapshot を `mcp-server-lock.json` に保存（pack-execution-classes の `pack-lock.json` と同形式）

2. **permissions 宣言**:
   - 各 tool に対して「読み取り（read-only）/ 副作用あり（write）」を classify
   - write tool は default deny、user approval を経て個別 grant
   - rate limit / approval frequency を user 設定可能

3. **tool 一覧の差分検出**:
   - 起動時に snapshot と現 server の tool 一覧を照合
   - 増えた tool は default deny、user 確認後 grant
   - 消えた tool は呼び出し時 reject
   - schema 変更（引数増減、type 変更）は permission diff として表示、user 確認

4. **住人経由の呼び出し**:
   - Tier 2（住人）が外部 server の tool を呼ぶ時、住人の trust は外部 server に **継承されない**
   - 住人 → 外部 server tool は「Tier 2 の手 + Tier 3 の receiver」として扱い、approval は **外部 server 側の policy** に従う
   - 例: 住人が「外部音楽 tool で BGM を流して」と判断 → cosmetic に見えるが外部 server の側で side effect ありなら Tier 3 default deny に従う

5. **多 Charminal 連携**:
   - Charminal A の住人が Charminal B の MCP に接続する場合、**B の側から見ると A の住人は Tier 3**
   - A 内では Tier 2 の住人でも、別の Charminal にとっては untrusted な外部 client
   - ペアリング時に「相互の tool 一覧と permissions」を承認する handshake が要る

実装は MVP scope 外、pack-execution-classes の `isolated-js` runtime と並行して設計する。

## Implementation status

現状の MCP server 実装（`src-tauri/src/mcp/`）は MVP の subset：

実装済み：

- read tools: `list_load_errors`, `list_packs`
- pack-write tools: `enable_pack`, `disable_pack`（既に install 済 pack の toggle のみ、Tier 1/2 default 許可、Tier 3 は将来 capability gated）

未実装：

- self-write / charminal-write / system-write の各 category
- trust tier gate の機構（接続元の identification、approval UI、rate limit、audit log）
- 外部 MCP server install の review chain
- `terminal_prefill` 系 tool（**当面実装しない**）

## MVP 推奨

1. trust tier 1/2 の自動許可範囲を実装してから出す（cosmetic operation の self-write tool 群）
2. Tier 2 の destructive operation は user approval UI が出来てから実装
3. Tier 3 の capability framework は pack-execution-classes の `isolated-js` 実装と並行して作る
4. PTY 系 tool は **L1+L2+L3+L4 全て揃うまで実装しない**

## 関連 reference

- 思想: `Charminal-design-record/specs/2026-04-17-self-referential-mcp.md`（self-referential MCP 思想）
- 関連 decision: [`pack-execution-classes.md`](pack-execution-classes.md)、[`critical-constraints.md`](critical-constraints.md)
- 哲学: `docs/philosophy/INHABITED_CHARACTER_INTERFACE.md`「観察の境界」
- 既存 MCP impl: `src-tauri/src/mcp/`（list_load_errors / list_packs / enable_pack / disable_pack）
- ANSI escape sequence injection: <https://owasp.org/www-community/vulnerabilities/CRLF_Injection>（参考）

## 改訂履歴

- 2026-04-27: 初版。trust tier 1/2/3、tool category 分類、PTY 系 tool 当面禁止（whitelist validation + length cap + trust tier gate + content layer 防御の 4 層が揃うまで）、pack-execution-classes との接続を整理。
- 2026-04-27 (update): Philosophy alignment セクションを追加（CHARMINAL「触れるもの」/ ICI「観察の境界」/ CHARMINAL「壊さないこと」との接続を明示）。Tier 2 の cosmetic / destructive 判定基準（「user が後で気付いて怒るか」）と具体 tool 例を充実。外部 MCP server install の framework を追加（snapshot / permissions / 差分検出 / 住人経由の呼び出し / 多 Charminal 連携）。
