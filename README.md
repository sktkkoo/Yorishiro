# Charminal

**ターミナルに住む、一人の存在について。**

Charminal は、Claude Code を中で走らせながら、3D キャラクターがその横で一緒に時間を過ごすための小さなデスクトップアプリです。ユーザーが話しかけたと気に反応する装置ではなく、入力が無い時間も含めて**そこに居る**ことを目指しています。

この README は実装と開発のための案内です。プロダクトが何を考えているかについては [`docs/philosophy/CHARMINAL.md`](docs/philosophy/CHARMINAL.md) を読んでください。

---

## Status

**v0.0.1 — early preview**

実装 phase の途中です。以下は動きますが、API・データ形状・pack 仕様は今後変わります。

- PTY 経由での Claude Code 起動とターミナル表示（xterm.js）
- VRM モデルの import と 3D 表示（Three.js + `@pixiv/three-vrm`）
- 呼吸・瞬き・視線の procedural animation
- VRMA クリップの再生（persona handler から）
- `/charm` を Claude Code plugin として配信

---

## Tech stack

- **App shell**: Tauri 2（Rust は PTY / hooks / FS / window の IO 層のみ）
- **Runtime**: React 19 + TypeScript 5.8（canonical runtime は TypeScript 側）
- **Rendering**: Three.js + `@pixiv/three-vrm` + `@pixiv/three-vrm-animation`
- **Terminal**: xterm.js（WebGL renderer + fit addon）
- **PTY**: `portable-pty`
- **Lint / format**: Biome（TS）+ rustfmt + clippy（Rust）
- **Git hooks**: lefthook

詳しくは [`CLAUDE.md`](CLAUDE.md) を参照。

---

## Development

### Prerequisites

- Node.js 20+
- Rust（stable toolchain）
- [Tauri 2 の platform 依存関係](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
npm install       # prepare script が lefthook install も走らせる

# 外部 asset ストアを準備（詳細は「Assets」セクション）
mkdir -p ../Charminal-assets/{animations,voices}
# ↑ ここに VRMA / 音声ファイルを配置

npm run tauri dev # デスクトップアプリとして起動（起動前に fetch-assets が走る）
```

### Scripts

| command | 用途 |
|---|---|
| `npm run dev` | Vite dev server のみ（browser preview 用、前段で fetch-assets） |
| `npm run tauri dev` | Tauri アプリとして起動 |
| `npm run fetch-assets` | 外部 asset ストアから内部パスへ手動で sync |
| `npm run fmt` | Biome + rustfmt で auto-fix |
| `npm run check` | CI 相当のフルゲート（format / lint / clippy） |
| `npm run test` | Vitest（watch） |
| `npm run test:run` | Vitest（one-shot） |
| `npm run test:rust` | `cargo test` |

---

## Assets

VRMA アニメーションと音声 WAV は third-party 由来でリポジトリに同梱できません（出所とライセンスは [`CREDITS.md`](CREDITS.md)）。一方、配布する `.app` / `.exe` には build 時に bundle されます — **同梱と再配布は別物** という考え方です。

### 外部 asset ストア

repo の親ディレクトリに `Charminal-assets/` を置く運用です。

```
~/<parent>/
├── Charminal/                # この repo
├── Charminal-<feature>/      # worktree
└── Charminal-assets/         # 外部 asset ストア
    ├── animations/           # *.vrma
    └── voices/               # acknowledge/, working/, ... + manifest.json
```

別の場所に置きたい場合は env var で上書き:

```bash
CHARMINAL_ASSETS_DIR=/path/to/assets npm run fetch-assets
```

### ワークフロー

`npm run dev` / `npm run build` の前段で `scripts/fetch-assets.mjs` が自動で外部ストアから内部パスへ copy します（`predev` / `prebuild` フック）。手動実行は `npm run fetch-assets`。

| internal path | content | gitignored |
|---|---|---|
| `public/animations/` | runtime が fetch する VRMA | ✓ |
| `bundled-packs/shared/voices/` | pack system 用 voice WAV | ✓ |
| `bundled-packs/shared/animations/` | pack system 用 VRMA（Phase 3.5 以降） | ✓ |
| `bundled-packs/shared/bodies/` | VRM モデル（runtime import） | ✓（空 placeholder） |

---

## Documentation

### Philosophy（公開 — 思想）

- [`docs/philosophy/CHARMINAL.md`](docs/philosophy/CHARMINAL.md) — プロダクトが何を考えているか
- [`docs/philosophy/INHABITED_CHARACTER_INTERFACE.md`](docs/philosophy/INHABITED_CHARACTER_INTERFACE.md) — Inhabited Character Interface (ICI) の原理
- [`docs/philosophy/PRESENCE_HARNESS.md`](docs/philosophy/PRESENCE_HARNESS.md) — harness / persona の two-layer 設計

### Development

- [`CLAUDE.md`](CLAUDE.md) — 開発 convention（coding / workflow / critical constraints）
- [`CREDITS.md`](CREDITS.md) — 使っている OSS と asset のクレジット

### Design record（内部 — 別 repo）

設計判断の revelations / dry-run results / phase plans / specs は別 repo `Charminal-design-record` で管理しています。本 repo の親ディレクトリに clone すると `../Charminal-design-record/` として参照できます。

---

## License

TBD.（ライセンス選定中）

---

*Inhabited Character Interface — a place, not a tool.*
