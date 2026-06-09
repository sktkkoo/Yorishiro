# Charminal — Documentation

> このファイルは「**Charminal の doc 全体の navigation 入口**」。dev / AI / pack 作者 / repo を訪れた人すべての最初の 1 ページ。「どこに何があるか」を 5 分で把握するための map。
>
> 公開向けの読み物（narrative）は [`philosophy/PHILOSOPHY.ja.md`](philosophy/PHILOSOPHY.ja.md) から始める。本 README は navigation 専用で、自身は narrative を持たない。

---

## 0. ここから始める（用途別 cheat sheet）

| やりたいこと | まず読むファイル |
|---|---|
| Charminal が何を目指しているか知りたい | [`philosophy/PHILOSOPHY.ja.md`](philosophy/PHILOSOPHY.ja.md) |
| TypeScript 側のどこに何があるか知りたい | [`../src/README.md`](../src/README.md) |
| Rust 側のどこに何があるか知りたい | [`../src-tauri/README.md`](../src-tauri/README.md) |
| Pack を書きたい | [`../src/sdk/README.md`](../src/sdk/README.md) |
| GitHub 等で共有された pack を手動導入したい | [`decisions/scene-execution-sandbox.md`](decisions/scene-execution-sandbox.md) |
| 標準 hook / DispatchEvent の語彙を確認したい | [`catalogs/standard-hooks.md`](catalogs/standard-hooks.md) |
| 過去に「なぜそう決めたか」を引きたい | [`decisions/README.md`](decisions/README.md) |
| 設計上踏んではいけない line を確認したい | [`decisions/critical-constraints.md`](decisions/critical-constraints.md) |
| `~/.charminal/config.json` の field を確認したい | [`configuration.md`](configuration.md) |
| Terminal の session profile / shell integration / カスタマイズを確認したい | [`terminal.md`](terminal.md) |
| 起動失敗・壊れた pack・safe mode の復旧手順を確認したい | [`troubleshooting.md`](troubleshooting.md) |
| Release 前の smoke test 手順を確認したい | [`release-checklist.md`](release-checklist.md) |
| Build / lint / test の動かし方を知りたい | [project root `CLAUDE.md`](../CLAUDE.md) §Linting & formatting |
| 自動生成された API doc を見たい | `npm run doc && open docs/api/typescript/index.html` |

---

## 1. Doc 構造（5 層）

```
公開思想 (narrative, drift しにくい)
  └─ docs/philosophy/   ← 作品宣言・原理。PHILOSOPHY.ja.md に統合。

決定 / 制約 (topic-indexed, drift 注意)
  └─ docs/decisions/    ← 「なぜそう決めたか」を topic 軸で。

内部設計記録 (date-indexed, 非公開別 repo)
  └─ ../Charminal-design-record/  ← revelations / dry-run / specs / plans。非公開。

Code 内 navigation (各 directory に短い README)
  └─ ../src/README.md, ../src-tauri/README.md, ../bundled-packs/README.md, ../src/<cluster>/README.md

User-private memory (auto-recall, 個人ローカル)
  └─ ~/.claude/projects/<encoded-cwd>/memory/  ← 会話横断の feedback / preference / project state。
                                                  Claude が起動時に MEMORY.md を読み、必要に応じて
                                                  個別 file を recall。読者は path 直接 cat で参照可能。
```

各層の **書き分け原則**：

- **philosophy/**: 整理済みの思想。未整理の思考メモは置かない
- **decisions/**: 「決定の事実 + 理由 + 代替案 + 関連 revelation」を topic で。過去の決定を topic 軸で引きたい時に来る場所
- **design-record (非公開別 repo)**: 思考過程・dry-run 結果・phase plan。整理されていなくてよい。外部からはアクセスできないため、公開に必要な決定は decisions/ に集約する
- **code 内 README**: 「この directory に何があるか」のみ。中身の解説は code の docstring 側
- **memory**: user 個別、会話横断、auto-recall。決定として固まったものは decisions/ に促進する

---

## 2. 思想（philosophy）

[`philosophy/PHILOSOPHY.ja.md`](philosophy/PHILOSOPHY.ja.md) に統合されています。問題意識 → Presence Harness → ICI → 二層構造 → 自己言及的 MCP → 境界 → 生きた系の順で読めます。

Source code 内で参照するときは：

- 公開思想：`docs/philosophy/X.md「セクション名」` の full path で
- 内部 design-record：`internal design-record: 2026-XX-XX-name.md Section X.X`（path は書かない、非公開別 repo にあるため）

---

## 3. Code の architecture map

### 3.1 言語層

| Layer | Path | 一行責務 | Entry |
|---|---|---|---|
| TypeScript | `src/` | canonical runtime（思考・反射・身体・UI 全て） | `src/main.tsx` → `src/App.tsx` |
| Rust | `src-tauri/src/` | IO 層（PTY / hooks / file I/O / MCP server） | `src-tauri/src/lib.rs:run()` |
| Bundled packs | `bundled-packs/` | 標準同梱の persona / scene / effect / shared assets | `bundled-packs/personas/clai/persona.ts` |

### 3.2 TypeScript top-level

| Directory | 責務 | 詳細 |
|---|---|---|
| `src/core/` | Presence Harness の primitive 層（body / time / perception / expression / space / scene / interaction / log-bridge / two-layer / dev-log / ui-layout / attention / tween） | [../src/core/README.md](../src/core/README.md) |
| `src/runtime/` | Pack 管理 / event dispatch / module registry / singleton services / ui-pack-registry / attention-runtime / ambient-ui-pack-registry / ambient-audio / session-tabs / surface-registry | [../src/runtime/README.md](../src/runtime/README.md) |
| `src/sdk/` | Pack 作者向け型定義と API contract（公開 surface） | [../src/sdk/README.md](../src/sdk/README.md) |
| `src/bindings/` | Tauri command bridge（TS ↔ Rust） | — |

### 3.3 Rust top-level

| Module | 責務 | 詳細 |
|---|---|---|
| `lib.rs` / `main.rs` | Tauri app entry / command 登録 / setup hook | [../src-tauri/README.md](../src-tauri/README.md) |
| `pty.rs` | Legacy PTY facade / hook server (port 19001) | 同上 |
| `sessions/` | Per-session PTY lifecycle / registry / shell wrapper / terminal agent adapter | 同上 |
| `mcp/` | MCP 1.5 server (port 18743 default) / pack diagnostics + self-referential tools | 同上 |
| User layer commands | `~/.charminal/` の watch / atomic write / pack scan | 同上 |

### 3.4 Bundled packs

| Pack | Kind | 詳細 |
|---|---|---|
| `bundled-packs/personas/clai/` | persona | flagship reference implementation |
| `bundled-packs/scenes/simple-room/` | scene | Phase 1 default scene（3 layer composition） |
| `bundled-packs/effects/screen-shake/` | effect | DOM shake on error |
| `bundled-packs/effects/abandoned-monitor/` | effect | 放置された監視端末風の全画面 ARG overlay |
| `bundled-packs/ui/charminal-settings/` | ui | 設定画面（F1 で開く default UI pack） |
| `bundled-packs/ui/camera-lighting-panel/` | ui | UI pack SDK の reference implementation。常用は非推奨（F2 panel で代替） |
| `bundled-packs/ambient-ui/attention-aura/`（Phase 1c 予定） | ambient-ui | 視線追跡 overlay 可視化（multi-active） |
| `bundled-packs/shared/` | shared assets | animations / voices / bodies |

詳細は [../bundled-packs/README.md](../bundled-packs/README.md)。

### 3.5 命名規則と命名強制の境界

| 対象 | TS 側 | Rust 側 | 強制方法 |
|---|---|---|---|
| Directory | kebab-case | snake_case | 手動（linter は無効） |
| Filename | camelCase / kebab-case 混在可 | snake_case | 手動 |
| Type / Class | PascalCase | PascalCase | 慣習 |
| Function / variable | camelCase | snake_case | 慣習 |
| Constant | SCREAMING_SNAKE_CASE | SCREAMING_SNAKE_CASE | 慣習 |

詳細は CLAUDE.md §Coding conventions。**TS / Rust で directory 構造は 1:1 mirror、命名のみ言語 idiom**。

---

## 4. 決定 / 制約の引き方

**Topic 軸で引きたい場合** → [`decisions/README.md`](decisions/README.md) の topic 索引から該当 page へ。

**特に重要な「破ってはいけない line」** → [`decisions/critical-constraints.md`](decisions/critical-constraints.md)。

**過去の試行錯誤や revelation の date 順を辿りたい場合** → 非公開別 repo `../Charminal-design-record/` の date-prefixed file を直接読む（開発者ローカルにのみ存在）。INDEX として `2026-04-11-design-exploration.md` の revelation 番号体系（3.1〜3.21）が起点。

> **重要**：design-record は非公開 repo で date-indexed、決定の **過程** を時系列で記録する。一方 decisions/ は **結果** を topic で引けるようにする。同じ事実が両方に出ることがあるが、役割が違うので両方に書いてよい。外部の読者は decisions/ だけで設計意図を追えるように維持する。

---

## 5. 自動生成 doc（毎回 fresh）

| Generator | Source | 出力 | 起動 |
|---|---|---|---|
| typedoc | `src/sdk/` | `docs/api/typescript/` | `npm run doc` |
| cargo doc | `src-tauri/src/` | `src-tauri/target/doc/` | `npm run doc:rust` |

これらは `.gitignore` 対象。**code を真実とし、doc を機械生成**する箇所。手で書かない。

`lefthook` が pre-push で typedoc validation、post-commit で typedoc 再生成を自動実行する（commit のたびに `docs/api/typescript/` がローカルで fresh になる）。

---

## 6. Tooling navigation

| やりたいこと | コマンド | 詳細 |
|---|---|---|
| dev server 起動 | `npm run tauri dev` | port 1430 |
| 全 lint + fmt check | `npm run check` | CI 相当 |
| auto-fix | `npm run fmt` | biome --write + cargo fmt |
| TS test | `npm run test:run` | vitest |
| Rust test | `npm run test:rust` | cargo test |
| API doc 生成 | `npm run doc` / `npm run doc:rust` | 上記参照 |

git hook（lefthook）は `npm install` で自動 install。pre-commit は staged file の軽量 fix、pre-push はフルゲート（typedoc validation 含む）、post-commit は typedoc 再生成。

---

## 7. このファイルの運用

- 本 README は **navigation のみ**。中身の解説を書かない（drift 源になる）
- code 構造を変更したら、対応する README と本 README の path / 役割記述だけ更新する
- 「new directory を追加したけど README に出てない」場合は更新する。逆は許容（README は code 全部を網羅しなくてよい、上位構造のみ）
- 思想や決定が固まったら **decisions/** か **philosophy/** のどちらに置くかを判断する。両方に書かない
- doc 同期確認の checklist は `/sync-docs` skill で walk-through 可能
