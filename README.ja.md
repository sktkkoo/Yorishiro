<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center"><strong>ターミナルに住む、一人の存在について。</strong></p>

Charminal は、ターミナルの中で動く AI に身体を与えるデスクトップアプリです。

中では Claude Code や Codex が走っています。その AI の存在をきちんとインタフェースとして表現しようとした結果、ターミナルは AI の手足になり、居場所になり、環境になりました。3D キャラクターが thinking 中に視線をさまよわせ、エラーに眉を顰め、ときどき勝手に動く——AI が「居る」ことが、画面から伝わるように。

昔見た SF やアニメの影響があります。パートナーとしての AI が PC の画面を動かし、書き換え、中の世界を自由に操作する。あの感触を目指しています。

> [English README](README.md)

プロダクトの思想については [`docs/philosophy/CHARMINAL.md`](docs/philosophy/CHARMINAL.md) を読んでください。

---

## Status

**v0.0.1 — early preview**

実装 phase の途中です。以下は動きますが、API・データ形状・pack 仕様は今後変わります。

- PTY 経由での Claude Code / Codex 起動とターミナル表示（xterm.js）
- VRM モデルの import と 3D 表示（Three.js + `@pixiv/three-vrm`）
- 呼吸・瞬き・視線の procedural animation
- VRMA クリップの再生（persona handler から）
- `/charm` を Claude Code plugin として配信

Terminal agent は `~/.charminal/config.json` の `terminalAgent` で選ぶ。未指定時は従来通り Claude Code を起動する。

```json
{
  "terminalAgent": "codex"
}
```

Codex support の初期範囲は「自動起動 + persona prompt overlay + PTY observation」。Claude Code hooks と `/charm` plugin は Claude Code 専用。設定 field の一覧は [`docs/configuration.md`](docs/configuration.md)、設計判断は [`docs/decisions/codex-terminal-agent.md`](docs/decisions/codex-terminal-agent.md)。

---

## Contributing

個人プロジェクトとして開発中です。Issue や Discussion は歓迎します。**Pull request は現在受け付けていません。**

---

## Tech stack

- **App shell**: Tauri 2（Rust は PTY / hooks / FS / window の IO 層のみ）
- **Runtime**: React 19 + TypeScript 5.8（canonical runtime は TypeScript 側）
- **3D / VRM**: Three.js + React Three Fiber + `@pixiv/three-vrm` + `@pixiv/three-vrm-animation`
- **Debug UI**: leva
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
npm run tauri dev # デスクトップアプリとして起動
```

> **Note:** 一部の asset（VRMA アニメーション、音声 WAV）は third-party 由来でリポジトリに同梱されていません。asset がなくてもアプリは起動しますが、キャラクターのアニメーションと音声が制限されます。

### Scripts

| command | 用途 |
|---|---|
| `npm run dev` | Vite dev server のみ（browser preview 用） |
| `npm run tauri dev` | Tauri アプリとして起動 |
| `npm run fmt` | Biome + rustfmt で auto-fix |
| `npm run check` | CI 相当のフルゲート（format / lint / clippy） |
| `npm run test` | Vitest（watch） |
| `npm run test:run` | Vitest（one-shot） |
| `npm run test:rust` | `cargo test` |

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

[MIT](LICENSE)

---

*Inhabited Character Interface — a place, not a tool.*
