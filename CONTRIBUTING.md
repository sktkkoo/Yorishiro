# Contributing to Charminal

Charminal へのコントリビュートガイド。

---

## Tech Stack

Tauri 2 + React 19 + TypeScript 5.8 + Three.js + @pixiv/three-vrm + xterm.js

- **TypeScript**: canonical runtime（思考・反射・身体・UI 全て）
- **Rust**: IO 層のみ（PTY / hooks / FS / window）

## Getting Started

```bash
# Prerequisites: Node.js 20+, Rust stable, Tauri CLI v2
npm install
npm run tauri dev    # dev server (port 1430)
```

## Coding Conventions

### Directory naming

- **TypeScript (`src/`)**: `kebab-case` for directories. Files inside can be camelCase (`logBridge.ts`) or kebab-case (`log-bridge.ts`)
- **Rust (`src-tauri/src/`)**: `snake_case` for directories and `.rs` files (enforced by rustc per RFC 430)

TS と Rust は構造を 1:1 で mirror するが、命名規則は言語 idiom に従う。

| concept | TS path | Rust path |
|---|---|---|
| LogBridge | `src/core/log-bridge/` | `src-tauri/src/core/log_bridge/` |
| TwoLayer | `src/core/two-layer/` | `src-tauri/src/core/two_layer/` |
| BodyScheduler | `src/runtime/body-scheduler/` | `src-tauri/src/runtime/body_scheduler/` |

### Identifier naming

- TypeScript: `PascalCase` for types/classes/interfaces, `camelCase` for functions/variables, `SCREAMING_SNAKE_CASE` for constants
- Rust: `PascalCase` for types, `snake_case` for functions/variables/fields, `SCREAMING_SNAKE_CASE` for constants (RFC 430)

### Comments / docstrings

コメントと docstring は **日本語** で書く。識別子とコード例は対象言語のまま。

## Linting & Formatting

- **TS**: Biome（formatter + linter + import organize を一括管理）
- **Rust**: rustfmt（[公式 Style Guide](https://doc.rust-lang.org/style-guide/)）+ clippy（`-D warnings` でゲート）

| コマンド | 用途 |
|---|---|
| `npm run fmt` | auto-fix（Biome --write + cargo fmt） |
| `npm run check` | read-only 検証（CI 相当） |
| `npm run lint` | lint のみ |
| `npm run test:run` | TS test（vitest） |
| `npm run test:rust` | Rust test（cargo test） |
| `npm run doc` | API doc 生成（typedoc → `docs/api/typescript/`） |
| `npm run doc:rust` | Rust API doc 生成（cargo doc） |

Git hook（lefthook）は `npm install` で自動 install される。

- **pre-commit**: staged file の軽量 fix
- **pre-push**: フルゲート（`biome check` / `cargo fmt --check` / `cargo clippy -- -D warnings` / typedoc validation）

> Directory / Identifier naming は linter で強制していない（Biome の `useFilenamingConvention` は意図的に無効）。手動で守ること。

## Development Workflow

機能開発は **git worktree** で進める。主ディレクトリは main の共有 baseline として置き、機能ごとに worktree を切る。

```bash
# worktree 作成
git worktree add ../Charminal-<feature> -b feat/<feature>
cd ../Charminal-<feature>
npm install  # 各 worktree が独自の node_modules を持つ

# 完了後
cd <repo-root>/Charminal
git merge feat/<feature>
git worktree remove ../Charminal-<feature>
git branch -d feat/<feature>
```

worktree を切らず main で直接作業していいケース:

- 1 ファイル 1 行レベルの typo 修正
- 並行作業がないとき

## Documentation

### 構造

| 層 | 場所 | 内容 | 対象読者 |
|---|---|---|---|
| Navigation | `docs/README.md` + 各 directory の `README.md` | pointer 集（drift しにくい） | 全員 |
| 公開思想 | `docs/philosophy/` | 作品宣言・原理 | repo を訪れた誰か |
| 決定 / 制約 | `docs/decisions/` | topic-indexed な設計判断と理由 | dev / contributor |
| Code 内 README | `src/README.md`, `src-tauri/README.md`, etc. | architecture overview | dev / contributor |
| 自動生成 | `docs/api/`（`.gitignore` 対象） | typedoc / cargo doc 出力 | dev |

全体の Navigation は [`docs/README.md`](docs/README.md) から始める。

### 設計判断

設計判断の詳細は [`docs/decisions/`](docs/decisions/) を参照。特に重要な設計境界は [`docs/decisions/critical-constraints.md`](docs/decisions/critical-constraints.md) にまとまっている。

### Doc 同期ルール（code 変更時）

| code 変更 | 更新先 | skip 可？ |
|---|---|---|
| `src/<top-level>/` 配下に新 directory を追加 | 当該 cluster README + `docs/README.md` の architecture map | ❌ 必須 |
| `src-tauri/src/` に新 module を追加 | `src-tauri/README.md` + `docs/README.md` | ❌ 必須 |
| 新しい設計判断が固まった / 既存決定を修正した | `docs/decisions/<topic>.md` を新規 or 改訂履歴 append | ❌ 必須 |
| Pack 種別 / registry の semantic 変更 | `bundled-packs/README.md` + `src/runtime/README.md` | ❌ 必須 |
| 個別 file の API / docstring 変更 | 不要（`npm run doc` で fresh 生成） | ✅ skip |
| Bug fix / 内部実装の変更 | 不要（commit message が source of truth） | ✅ skip |

## Pack Development

Pack の書き方は [`src/sdk/README.md`](src/sdk/README.md) を参照。bundled pack（[`bundled-packs/`](bundled-packs/)）がリファレンス実装として参照可能。

ユーザー作成 pack は local trusted code として扱う。公開 registry / in-app community install / `/charm:prepare-publish` は未提供なので、`/charm:create` 生成物を sandbox 済み・review 済み・公開配布可能 artifact と説明しない。

source checkout で user pack を検査する場合：

```bash
npm run check:pack -- ~/.charminal/packs/<pack-id>
npm run check:pack -- --mode publish-candidate ~/.charminal/packs/<pack-id>
```

`local-authoring` mode は `/charm:create` 生成物向け。`publish-candidate` mode は将来の registry review 前チェックの preview であり、現時点では正式な公開 gate ではない。公開提出機能はまだ無く、JS / TS scan も AST 実装前の heuristic に留まる。
