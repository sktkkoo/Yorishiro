<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center"><strong>ターミナルの中の AI に、身体を。</strong></p>

Charminal は、ターミナルの中で動く AI に身体を与えるデスクトップアプリです。

中では Claude Code や Codex が走っています。AI が考え込んでいるあいだ、3D キャラクターが視線をさまよわせる。エラーが出ると、言葉にするより先に眉が顰められる。ときどき、何の脈絡もなく勝手に動く。スピナーの代わりに、そこに誰かが居ます。

住人は自分の住む世界を操作できます。scene を切り替え、環境音を変え、表情を動かし、空間にエフェクトを走らせる。ユーザーも pack を書くことで、住人の性格、空間、反応のすべてを作り替えられます。動作中に、止めることなく。

かつてSF やアニメで見た、パートナーとしての AI が画面の中を自由に動きまわり、UIを操作し、助けてくれる--そんな体験を作り出そうとするプロジェクトです。

> [English README](README.md)

---

## Status

**v0.0.1 — early preview**

実装 phase の途中です。API・データ形状・pack 仕様は今後変わります。

今できること：

- Claude Code / Codex をターミナルとして起動し、そのまま作業できる
- VRM モデルの 3D キャラクターが呼吸し、瞬きし、視線を動かし、表情で反応する
- VRMA アニメーションクリップの再生
- 6 種類の pack（persona / scene / effect / ui / utility / ambient-ui）を作成・読み込みできる
- scene の切り替え、環境音の再生、カメラ・ライティングの操作
- 自己言及的 MCP——住人（Claude Code）が MCP 経由で Charminal 自身を操作できる（表情、エフェクト、scene 切り替え、UI 操作など 20 以上の tool）
- `/charm` を Claude Code plugin として配信——pack の作成・編集・チュートリアルなど

Terminal agent は `~/.charminal/config.json` の `terminalAgent` で選べます。未指定時は Claude Code が起動します。

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

### Philosophy — このプロジェクトの思想

- [`docs/philosophy/CHARMINAL.md`](docs/philosophy/CHARMINAL.md) — なぜ AI に身体が要るのか。意識と反射の二層構造について
- [`docs/philosophy/INHABITED_CHARACTER_INTERFACE.md`](docs/philosophy/INHABITED_CHARACTER_INTERFACE.md) — UI を「場所」として捉え、AI を「住人」として存在させるという考え方
- [`docs/philosophy/PRESENCE_HARNESS.md`](docs/philosophy/PRESENCE_HARNESS.md) — AI の能力ではなく、AI がどう在るかを設計するということ

### Development

- [`CLAUDE.md`](CLAUDE.md) — 開発 convention（coding / workflow / critical constraints）
- [`CREDITS.md`](CREDITS.md) — 使っている OSS と asset のクレジット

### Design record（内部 — 別 repo）

設計判断の revelations / dry-run results / phase plans / specs は別 repo `Charminal-design-record` で管理しています。本 repo の親ディレクトリに clone すると `../Charminal-design-record/` として参照できます。

---

## License

[MIT](LICENSE)

---

*場所であって、道具ではない。*
