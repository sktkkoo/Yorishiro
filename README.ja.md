<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">Charminal</h1>

<p align="center"><strong>ターミナルの中の AI に、身体を。</strong></p>

<p align="center"><sub><strong>Charm</strong>inal = <strong>Char</strong>acter + Ter<strong>minal</strong> + <strong>Charm</strong></sub></p>

Charminal は、ターミナルの中で動く AI に身体を与えるデスクトップアプリです。ターミナルを含めたアプリ全体を、キャラクターの「住環境」として扱います。

中では Claude Code や Codex が走っています。AI が考え込んでいるあいだ、3D キャラクターが視線をさまよわせる。エラーが出ると、言葉にするより先に眉が顰められる。ときどき、何の脈絡もなく勝手に動く。スピナーの代わりに、そこに誰かが居ます。

住人は自分の住む世界を操作できます。シーンを切り替え、表情を動かし、空間にエフェクトを走らせる。ユーザーも住人と対話するだけで、住人の性格、空間、反応のすべてを作り替えられます。動作中に、止めることなく。

かつてSF やアニメで見た、パートナーとしての AI が画面の中を自由に動きまわり、UIを操作し、助けてくれる--そんな体験を作り出そうとするプロジェクトです。

なお、Charminal 自体の開発の大部分が、Charminal 上で動く AI との共同作業として行われています。

> [English README](README.md)

---

## Getting Started

### 前提条件

Charminal はユーザーのローカル環境にインストールされた Claude Code または Codex をターミナル上で自動起動する仕組みです。そのため：

- **事前に [Claude Code](https://docs.anthropic.com/en/docs/claude-code) の環境構築が必要です**
- Charminal が API キーを要求することはありません。代わりに、ユーザー環境の Claude Code の token をそのまま消費します

### インストール（macOS）

[Releases](https://github.com/sktkkoo/Charminal/releases) から `.dmg` をダウンロードし、`charminal.app` を `/Applications` にドラッグしてください。署名されていないため、初回起動前に quarantine 属性を解除します：

```bash
xattr -cr /Applications/charminal.app
```

### 起動（ソースから）

```bash
npm install
npm run tauri dev
```

起動すると Claude Code がターミナル内で立ち上がり、同梱の VRM キャラクター **CLAI**（クライ）が隣に表示されます。普段通りに Claude Code を使えます。

### `/charm` コマンド

Claude Code 内で `/charm` と入力すると、Charminal 専用の plugin が起動します。pack の作成・編集・チュートリアルなどを対話的に行えます。

### 言語

Charminal は `language: "auto"` を既定値として、起動時にアプリ言語を自動検出します。日本語環境では日本語 UI、日本語 default persona、日本語の global prompt guidance、日本語の `/charm:*` command prompt を使います。それ以外の環境では英語を使います。設定画面または `~/.charminal/config.json` から変更できます。

### Pack

Charminal の挙動はすべて **pack** で構成されています。6 種類あります：

| 種類 | 役割 |
|---|---|
| **persona** | 住人の性格・反応パターンを定義する |
| **scene** | 背景・空間・ライティング・環境音を構成する |
| **effect** | 一時的な視覚演出（画面シェイク、花火など） |
| **ui** | 設定画面などの UI |
| **ambient-ui** | 常時表示のオーバーレイUI（注視表示など） |
| **utility** | 表示を持たない裏方ロジック |

Bundled pack がデフォルトで動作します。ユーザーは `~/.charminal/packs/` に自作 pack を置くことで、基盤機能を除くほぼすべて（住人の性格・空間・反応・UIなど）を作り替えられます。`/charm` コマンドを利用することで、住人と対話するだけで簡単に改変や作成を行えます。Pack は [hot reload](docs/configuration.md#pack-の-hot-reload) に対応していますが、うまく反映されない場合は Ctrl+R で確実に反映できます。

ユーザー作成 pack は **local trusted code** として扱われます。sandbox 済み・review 済み・public registry 用 artifact ではありません。現時点の Charminal は public pack registry、in-app community pack install、`/charm:prepare-publish` をまだ提供していません。GitHub 等で pack の source code を共有することはできますが、手動で導入する利用者は local trusted code として自己責任で実行する扱いです。

### データディレクトリ

Charminal のユーザーデータは `~/.charminal/` に保存されます：

```
~/.charminal/
├── config.json      # Persona・scene・terminal agent などの設定
├── init.js          # 起動時に実行されるユーザースクリプト（Emacs の init.el 相当）
├── packs/           # ユーザー作成の pack
├── journal/         # 住人の日々の記録と記憶
├── shell/           # Shell integration スクリプト（自動生成）
└── sdk.d.ts         # Charminal SDK の型定義（自動生成、編集不要）
```

`config.json` で persona・scene・terminal agent などを切り替えられます。詳細は [`docs/configuration.md`](docs/configuration.md)。

---

## Features

### 反射層

住人はターミナルの出力を常に観察しています。hooks や PTY に流れるテキストを persona pack の trigger が拾い、表情やモーションとして即座に反応します。この反応は LLM を経由しない反射的なもので、熱いやかんに触って手を引っ込めるように、言葉より先に身体が動きます。住人の注意が向いている場所は Attention Aura として画面上に淡く光ります。

### Journal [開発中]

住人は `~/.charminal/journal/daily/` に日々の記録を書き残せます。印象に残った出来事の要約は `memories.md` に蓄積され、次回以降のセッションで思い出として参照されます。セッションをまたいだ長期記憶の仕組みです。

### Session tabs

メインの agent ターミナルとは別に、複数の shell セッションを開けます。`Cmd+T` で新しい shell タブを開き、`Ctrl+Tab` / `Ctrl+Shift+Tab` でタブを切り替え、`Cmd+W` で現在のタブを閉じます。メインの agent セッションは保護されており閉じられません——予期せず終了した場合は自動的に再起動します。

### コンテキスト共有

画面に見えているものと AI が知っていることのギャップを埋める小さな機能群です。**Terminal Reference Marker** は、ターミナル上の行を Cmd+click（または Option+Shift+drag で矩形選択）すると `[#Term1]` のようなマーカーが入力に挿入され、AI が参照テキストを解決できる仕組みです。**Voice Summary** は住人がレスポンスの要約を声で報告する機能で、長い出力を読み通さなくても概要を把握でき、認知負荷を下げます。音声は macOS では `say`、Windows では `System.Speech.Synthesis.SpeechSynthesizer` を使用。他の音声エンジンへの対応も検討中です。

### 自己言及的 MCP

住人（ターミナル内の Claude Code）は MCP 経由で Charminal 自身を操作できます——表情を変え、シーンを切り替え、エフェクトを走らせ、UI を操作する。

この仕組みには三つの特徴があります。

**身体と環境が同じインターフェース。** 住人にとって、自分の表情を変えることと部屋の照明を変えることは同じ操作です。身体と空間のあいだに API の境目がなく、すべてが MCP tool として並んでいます。

**ユーザーと住人の対称性。** ユーザーが UI で操作できるものと、住人が MCP で操作できるものは（一部を除いて）同じです。ユーザーがカメラの画角を変えれば住人はそれを認識できるし、ユーザーは夜に照明を暖色に変えてもらうよう住人に頼むこともできます。

**経路の有無が境界になる。** MCP の経路は住人の身体と空間には通っていますが、ユーザーの作業ファイルや Claude Code / Codex の思考過程には通っていません。「触るな」というルールを Claude Code / Codex に守らせるのではなく、そもそも経路が存在しないという構造で安全性と自律性を担保します。

---

## Status

**v0.3.0-alpha**

実装 phase の途中です。API・データ形状・pack 仕様は今後変わります。

今できること：

- Claude Code をターミナルとして起動し、そのまま作業できる
- Session tabs: agent と並行して複数の shell セッションを操作（`Cmd+T` / `Ctrl+Tab`）
- VRM の 3D キャラクター CLAI が呼吸し、瞬きし、視線を動かす（同梱）
- VRMA アニメーションクリップの再生
- 6 種類の pack によるカスタマイズ（persona / scene / effect / ui / utility / ambient-ui）
- 自己言及的 MCP（20 以上の tool）— カメラ・ライティング制御を含む
- 反射層による PTY 観察と即時反応
- コンテキスト共有: Terminal Reference Marker（Cmd+click / Option+Shift+drag）と Voice Summary
- Journal による長期記憶 [開発中]
- `/charm` による pack の対話的な作成・編集
- Windows ビルド対応（準備済み、動作未確認）

---

## Experimental

### Codex support

[Codex](https://github.com/openai/codex) を terminal agent として使用できます。`~/.charminal/config.json` で切り替えます：

```json
{
  "terminalAgent": "codex"
}
```

自動起動・persona prompt overlay・PTY observation・Charminal MCP access が動作します。ただし Claude Code hooks と `/charm` plugin は Claude Code 専用のため、Codex 使用時は利用できません。

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

詳しくは [`CONTRIBUTING.md`](CONTRIBUTING.md) を参照。

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

- [`docs/philosophy/INHABITED_CHARACTER_INTERFACE.md`](docs/philosophy/INHABITED_CHARACTER_INTERFACE.md) — UI を「場所」として捉え、AI を「住人」として存在させるという考え方
- [`docs/philosophy/CHARMINAL.md`](docs/philosophy/CHARMINAL.md) — なぜ AI に身体が要るのか。意識と反射の二層構造について
- [`docs/philosophy/PRESENCE_HARNESS.md`](docs/philosophy/PRESENCE_HARNESS.md) — AI の能力ではなく、AI がどう在るかを設計するということ

### 設定とカスタマイズ

- [`docs/configuration.md`](docs/configuration.md) — `~/.charminal/config.json` の field 一覧
- [`docs/terminal.md`](docs/terminal.md) — Terminal session の profile / shell カスタマイズ / OSC 133 shell integration

### Development

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 開発 convention（tech stack / coding / workflow）
- [`CREDITS.ja.md`](CREDITS.ja.md) — 使っている OSS と asset のクレジット ([English](CREDITS.md))

### Design record（内部 — 別 repo）

設計判断の revelations / dry-run results / phase plans / specs は別 repo `Charminal-design-record` で管理しています。本 repo の親ディレクトリに clone すると `../Charminal-design-record/` として参照できます。

---

## License

[MIT](LICENSE)

---
