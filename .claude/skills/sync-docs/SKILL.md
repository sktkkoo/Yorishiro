---
name: sync-docs
description: Use after a code change to walk the Charminal doc-drift cheat sheet. Identifies which README / decisions / INDEX entries need updating based on what changed in src/, src-tauri/, bundled-packs/, or design intent. Skip auto-generated doc (typedoc/cargo doc).
---

# sync-docs — doc drift 検出と修正

Charminal で code を触った後 / 設計判断を変えた後に、**どの doc を更新すべきか** を体系的に walk するための skill。CLAUDE.md「Drift 防止 cheat sheet」を実行可能な checklist 形式にしたもの。

## 起動条件

以下のいずれかに該当するなら invoke：

- `src/<top-level>/`、`src-tauri/src/`、`bundled-packs/` の **directory 構造** が変わった
- 新しい **設計判断** が固まった、または **過去の決定を修正・無効化** した
- **Critical constraint** を追加・改訂した
- Pack 種別 / registry の **semantic** が変わった
- 「commit する前に doc が code に追いついているか確認したい」と user が言った

逆に、**個別 file の implementation 変更 / 関数 rename / bug fix / API docstring 編集だけ** なら invoke しない（typedoc / cargo doc が拾う）。

## 手順

### 1. 直近の変更を診断する

```bash
git diff --stat HEAD
git status -s
```

`A`/`D` の row、特に directory 単位の追加・削除に注目。`M` は file 内変更なので原則 doc 影響なし（API surface 以外）。

### 2. 以下の checklist を順番に走る

各 item について「該当する変更があったか」を判定し、該当するなら指示された doc を確認・更新する。

#### A. Directory 追加 / 削除

- [ ] `src/<top-level>/` 配下に新 directory を追加した？
  - YES → 当該 cluster README（[`src/core/README.md`](../../../src/core/README.md) / [`src/runtime/README.md`](../../../src/runtime/README.md)）の Sub-module 一覧に行を追加
  - YES → [`docs/INDEX.md`](../../../docs/INDEX.md) §2.2 TypeScript top-level の table に追加（top-level 直下なら）
  - YES → 必要なら新 directory に短い `README.md` を置く（責務 / entry / 依存の 3 行）

- [ ] `src-tauri/src/` に新 module を追加した？
  - YES → [`src-tauri/README.md`](../../../src-tauri/README.md) Module map に追加
  - YES → [`docs/INDEX.md`](../../../docs/INDEX.md) §2.3 Rust top-level に追加
  - YES → 新しい `#[tauri::command]` を export したなら src-tauri/README.md の command 一覧にも追加

- [ ] `bundled-packs/` 配下に pack を追加 / 削除した？
  - YES → [`bundled-packs/README.md`](../../../bundled-packs/README.md) §同梱 pack 一覧 を更新

#### B. 設計判断の変更

- [ ] 新しい決定が固まった？
  - YES → [`docs/decisions/`](../../../docs/decisions/) 配下に `<topic>.md` を新規作成（format は [decisions/README.md](../../../docs/decisions/README.md) の「ファイル format」に従う）
  - YES → [`docs/decisions/README.md`](../../../docs/decisions/README.md) の Topic 索引に entry を追加

- [ ] 既存の決定を修正・無効化した？
  - YES → 該当する `docs/decisions/<topic>.md` の本体を書き直し、末尾の「改訂履歴」section に変更行を追加
  - YES → Status を `active` / `superseded` / `partial` から適切に更新
  - **重要**：「過去の設計意図が後から無効化された」case は **必ず** decisions/ に残す（design-record だけだと date 順で埋もれる）

- [ ] Critical constraint を追加・改訂した？
  - YES → [`docs/decisions/critical-constraints.md`](../../../docs/decisions/critical-constraints.md) を更新
  - YES → [`CLAUDE.md`](../../../CLAUDE.md) §Critical constraints to honor の箇条書き reminder も同期

#### C. Pack / Registry の変更

- [ ] Pack registry の active 数 semantic（single-active / 複数並行）が変わった？
  - YES → [`src/runtime/README.md`](../../../src/runtime/README.md) §Pack registry の semantic 違い の table を更新
  - YES → 関連する `docs/decisions/` entry があれば改訂履歴を追記

- [ ] User pack / bundled pack の override 挙動が変わった？
  - YES → [`bundled-packs/README.md`](../../../bundled-packs/README.md) と [`src/runtime/README.md`](../../../src/runtime/README.md) を確認
  - YES → 関連 memory（`feedback_pack_override_pattern.md`、`feedback_bundled_pack_immutability.md`）の妥当性も口頭で flag

### 3. 「触らなくていい」確認

以下は **doc 更新の対象外**。確認しても変更しない：

- `src/sdk/` 配下の `.d.ts` 内の docstring（typedoc が拾う）
- 個別 function / class の実装変更
- Bug fix（commit message が source of truth）
- 関数 / 型 rename（grep で参照を変えるだけ）

### 4. 最終チェック

```bash
npm run fmt:check  # markdown は biome 対象外だが、JSON / TS の整合確認
npm run doc        # typedoc が clean に通るか
```

doc 生成が通らない（`disableSources` のような config 問題、または .d.ts に新しい error）場合は修正。

## Output 形式

skill 実行後、user に向けて以下を報告：

```
## 更新した doc
- <path>: <一行で何を変えたか>
...

## 更新不要と判定したもの
- <該当 case>: <理由>

## 注意 / flag
- <あれば、判断に迷った点や user 確認が必要な点>
```

## アンチパターン

- 「念のため全 README を update する」→ NO。drift 源を増やす。touch しない doc は touch しない
- 「typedoc 出力を手で書き直す」→ NO。生成物。手で書いたら次の `npm run doc` で消える
- 「decisions/ entry を新規作成しないで既存 entry に詰め込む」→ topic 軸で引けなくなる。新しい topic は新規 file
- 「`docs/INDEX.md` に code の中身を書く」→ INDEX は pointer のみ。中身を書くと drift 源
