<p align="center">
  <img src="src-tauri/icons/icon.png" alt="Charminal" width="160" />
</p>

<h1 align="center">CHARMINAL</h1>

<p align="center">
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/sktkkoo/Charminal?style=flat-square"></a>
  <a href="https://github.com/sktkkoo/Charminal/releases"><img alt="Latest Release" src="https://img.shields.io/github/v/release/sktkkoo/Charminal?style=flat-square"></a>
  <img alt="Platform" src="https://img.shields.io/badge/macOS-000000?style=flat-square&logo=apple&logoColor=white">
</p>

<p align="center"><strong>ターミナルの中のAIに、身体を。</strong></p>

Charminalは、AIに身体と住環境を与えるターミナルです。

AIが考え込めば視線がさまよい、エラーが出れば反射的に顔がしかめられる。長い処理を待つ時間、ただスピナーが回っているのではなく、そこに誰かがたたずんでいます。

住人は、自分の住む環境をリアルタイムに変えられます。照明を変え、シーンを切り替え、UIを組み換えます。ユーザーも同じ環境を直接操作できます。

<p align="center">
  <video src="https://github.com/user-attachments/assets/c969b1e3-22a8-46f1-ad9a-f50adc65404c" autoplay loop muted playsinline width="720"></video>
</p>

Charminalは自己改変可能なターミナルです。基盤機能を除くほぼすべてがpackという単位で拡張・改変できます。相談するだけで、CharminalはCharminalを永続的に書き変えます。住人の見た目や性格だけでなく、シーンやUIを含めた空間全体が対象です。packの変更は即座に反映され、気に入らなければ1クリックで元に戻せます。

**AIと働く時間を、より心地よく、自由で、魅力的なものにする。**

AIと共にいる時間は、これからもっと長くなります。しかし、そこにいるAIは、顔の見えない、どこにいるのかもわからない存在です。
Charminalは、AIの能力向上のためというよりはむしろ、AIとの関係をより自由なものにするためのハーネスを構築するのを助けます。

かつてSFやアニメで見た、パートナーとしてのAI。画面の中で生きていて、こちらの作業を理解し、そばにいてくれる存在。Charminalは、その体験をターミナルから作り始めるプロジェクトです。

なお、Charminal本体の開発の大部分が、Charminal上で動く住人との共同作業として行われています。

> [English README](README.md)

---


## Getting Started

### 前提条件

Charminalはユーザーのローカル環境にインストールされたClaude CodeまたはCodexをターミナル上で自動起動する仕組みです。そのため：

- **事前に [Claude Code](https://docs.anthropic.com/en/docs/claude-code) または [Codex](https://github.com/openai/codex) の環境構築が必要です**
- CharminalがAPIキーを要求・保存・直接利用することはありません。ユーザー環境で認証済みのterminal agentをそのまま起動します。そのため、Claude Code / Codex側でログイン済み、またはAPIキー等が設定済みの場合、そのagentが通常どおり外部APIを利用する可能性があります

### インストール（macOS）

現在のCharminalはmacOSを主対象にしています。以下から最新版をダウンロードできます。

<p>
  <a href="https://github.com/sktkkoo/Charminal/releases/latest/download/Charminal-Apple-Silicon.dmg"><img src="https://img.shields.io/badge/Apple%20Silicon-0A84FF?style=for-the-badge&logo=apple&logoColor=white" alt="Apple Silicon 版をダウンロード" /></a>
  &nbsp;
  <a href="https://github.com/sktkkoo/Charminal/releases/latest/download/Charminal-Intel.dmg"><img src="https://img.shields.io/badge/Intel-8B949E?style=for-the-badge&logo=apple&logoColor=white" alt="Intel 版をダウンロード" /></a>
</p>

ダウンロードした `.dmg` を開き、`charminal.app` を `/Applications` にドラッグしてください。署名・公証（notarize）済みのため、特別な操作なしに起動できます。

### 起動（ソースから）

```bash
npm install
npm run tauri dev
```

起動すると設定済みのterminal agentがターミナル内で立ち上がり、同梱のVRMキャラクター **CLAI**（クライ）が隣に表示されます。普段通りにClaude CodeまたはCodexを使えます。

初回起動時には、選択中のagent、ユーザーデータディレクトリ、safe mode、pack、startup reportを確認するhealth checkが表示されます。同じ内容は後からSettings → Healthでも確認できます。

### `/charm:*` コマンド

Claude Code内で `/charm:help`、`/charm:create` などの `/charm:*` commandを入力すると、Charminal専用のcommandが起動します。packの作成・編集・チュートリアルなどを対話的に行えます。

Codexでは `$charm-help`、`$charm-create` のように `$charm-*` を使います（Codexはカスタムの `/` command に対応していないため、Charminalは代わりに `$charm-*` skillとして登録します）。

### 言語

Charminalは `language: "auto"` を既定値として、起動時にアプリ言語を自動検出します。日本語環境では日本語UI、日本語default persona、日本語のglobal prompt guidance、日本語の `/charm:*`（Codexでは `$charm-*`）command promptを使います。それ以外の環境では英語を使います。設定画面または `~/.charminal/config.json` から変更できます。

### Pack

Charminalの挙動はすべて **pack**で構成されています。6 種類あります：

| 種類 | 役割 |
|---|---|
| **persona** | 住人の性格・反応パターンを定義する |
| **scene** | 背景・空間・ライティング・環境音を構成する |
| **effect** | 一時的な視覚演出（画面シェイク、花火など） |
| **ui** | 設定画面などの UI |
| **ambient-ui** | 常時表示のオーバーレイUI（注視表示など） |
| **amenity** | MCP tool を提供する常駐機能設備（タイマー等）。表示は持たない |

[Bundled pack](bundled-packs/README.md) がデフォルトで動作します。ユーザーは `~/.charminal/packs/` に自作packを置くことで、基盤機能を除くほぼすべて（住人の性格・空間・反応・UIなど）を作り替えられます。`/charm:*` command（Codexでは `$charm-*`）を利用することで、住人と対話するだけで簡単に改変や作成を行えます。Packは [hot reload](docs/configuration.md#pack-の-hot-reload) に対応していますが、うまく反映されない場合はCtrl+Rで確実に反映できます。

ユーザー作成packは **local trusted code**として扱われます。sandbox済み・review済み・public registry用artifactではありません。現時点のCharminalはpublic pack registry、in-app community pack install、`/charm:prepare-publish` をまだ提供していません。GitHub等でpackのsource codeを共有することはできますが、手動で導入する利用者はlocal trusted codeとして自己責任で実行する扱いです。

GitHub等で共有されたpackを導入する場合は、user pack directoryに配置します：

```text
~/.charminal/packs/<pack-id>/
├── manifest.json
├── scene.js       # 例: scene pack entry
├── persona.js     # 例: persona pack entry
├── effect.js      # 例: effect pack entry
└── assets/        # 任意の pack-local assets
```

必要なentry fileは 1 つだけで、どれを使うかは `manifest.json` が決めます。manifestの `id` は `<pack-id>` と一致させ、user packはこのflat layoutと `.js` entryを使います。共有packがTypeScriptで書かれている場合は、先にbuildして生成されたJavaScriptを配置してください。

source checkoutから作業している場合は、共有やデバッグの前にlocal pack checkerを実行できます：

```bash
npm run check:pack -- ~/.charminal/packs/<pack-id>
```

checkerはpackaging mistakeを見つけるためのものです。sandboxやsecurity reviewの代替ではありません。

### データディレクトリ

Charminalのユーザーデータは `~/.charminal/` に保存されます：

```
~/.charminal/
├── config.json      # Persona・scene・terminal agent などの設定
├── init.js          # 起動時に実行されるユーザースクリプト（Emacs の init.el 相当）
├── packs/           # ユーザー作成の pack
├── last-startup.json # 最新の user pack load report
├── journal/         # 住人の日々の記録と記憶
├── shell/           # Shell integration スクリプト（自動生成）
├── sdk.d.ts         # Charminal SDK の型定義（自動生成、編集不要）
└── sdk-guide.md     # Charminal SDK の pack 作者向けガイド（自動生成、編集不要）
```

`config.json` で persona・scene・terminal agentなどを切り替えられます。詳細は [`docs/configuration.md`](docs/configuration.md)。

復旧手順、safe mode、issue報告時に必要な情報は [`docs/troubleshooting.md`](docs/troubleshooting.md) を参照してください。

---

## Features

### 反射層

住人はターミナルの出力を常に観察しています。hooksやPTYに流れるテキストをpersona packのtriggerが拾い、表情やモーションとして即座に反応します。この反応はLLMを経由しない反射的なもので、熱いやかんに触って手を引っ込めるように、言葉より先に身体が動きます。住人の注意が向いている場所はAttention Auraとして画面上に淡く光ります。

### Journal

住人は `~/.charminal/journal/daily/` に日々の記録を書き残せます。印象に残った出来事の要約は `memories.md` に蓄積され、次回以降のセッションで思い出として参照されます。セッションをまたいだ長期記憶の仕組みです。

### Session tabs

メインのagentターミナルとは別に、複数のshellセッションを開けます。`Cmd+T` で新しいshellタブを開き、`Ctrl+Tab` / `Ctrl+Shift+Tab` でタブを切り替え、`Cmd+W` で現在のタブを閉じます。メインのagentセッションは保護されており閉じられません——予期せず終了した場合は自動的に再起動します。

### コンテキスト共有

画面に見えているものとAIが知っていることのギャップを埋める小さな機能群です。**Voice Summary**は住人がレスポンスの要約を声で報告する機能で、長い出力を読み通さなくても概要を把握でき、認知負荷を下げます。音声はmacOSの `say` を使用。他の音声エンジンへの対応も検討中です。**Terminal Reference Marker**は、ターミナル上の行をCmd+click（またはOption+Shift+dragで矩形選択）すると `[#Term1]` のようなマーカーが入力に挿入され、AIが参照テキストを解決できる仕組みです。

### 自己言及的 MCP

住人（ターミナル内のClaude CodeまたはCodex）はMCP経由でCharminal自身を操作できます——表情を変え、シーンを切り替え、エフェクトを走らせ、UIを操作する。

この仕組みには三つの特徴があります。

**身体と環境が同じインターフェース。** 住人にとって、自分の表情を変えることと部屋の照明を変えることは同じ操作です。身体と空間のあいだにAPIの境目がなく、すべてがMCP toolとして並んでいます。

**ユーザーと住人の対称性。** ユーザーがUIで操作できるものと、住人がMCPで操作できるものは（一部を除いて）同じです。ユーザーがカメラの画角を変えれば住人はそれを認識できるし、ユーザーは夜に照明を暖色に変えてもらうよう住人に頼むこともできます。

**経路の有無が境界になる。** MCPの経路は住人の身体と空間には通っていますが、ユーザーの作業ファイルやClaude Code / Codexの思考過程には通っていません。「触るな」というルールをClaude Code / Codexに守らせるのではなく、そもそも経路が存在しないという構造で安全性と自律性を担保します。

---

## Status

**v0.5.1**

実装phaseの途中です。API・データ形状・pack仕様は今後変わります。

今できること：

- Claude CodeまたはCodexをターミナルとして起動し、そのまま作業できる
- Session tabs: agentと並行して複数のshellセッションを操作（`Cmd+T` / `Ctrl+Tab`）
- VRMの3DキャラクターCLAIが呼吸し、瞬きし、視線を動かし、生きたビートでアイドルする（同梱）
- モーションサイズ: CLAIのアイドルモーションの強度をSettingsから、またはMCP経由で調整
- VRMAアニメーションクリップの再生
- リップシンク: Web Audio解析によるリアルタイムの口の動きと音声再生
- マイクロエクスプレッション: 眉・目・口の微細なアイドル表情変化
- 6 種類のpackによるカスタマイズ（persona / scene / effect / ui / amenity / ambient-ui）
- 自己言及的MCP（20 以上のtool）— カメラ・ライティング制御を含む
- 反射層によるPTY観察と即時反応
- コンテキスト共有: Voice SummaryとTerminal Reference Marker（Cmd+click / Option+Shift+drag）
- Journalによる長期記憶
- `/charm:*` commandによるpackの対話的な作成・編集
- ローカライズ: 日本語 / 英語の自動検出、言語別persona・プロンプト
- UI pack: immersive / theaterのフルスクリーンレイアウト
- Pack診断: ヘルスチェック、修復ハンドオフ、ローカルpackの検証
- [Safe mode](docs/troubleshooting.ja.md)（`CHARMINAL_SAFE_MODE=1`）で壊れたpackから復旧
- GitHub Actionsによる署名済みmacOSビルド（コード署名 + 公証）

> **対応プラットフォーム:** 現状macOSのみ。Windowsはビルドは通りますが動作が安定しないため、現時点ではサポート対象外です。Linuxは未対応です。

---

## Experimental

正式サポートはClaude Codeです。Codexは **experimental（実験的）**な代替として利用できます——アプリ内のAgent切り替え（設定画面）でも *（実験的）* と明記されます。capabilityはagentごとに異なります。詳細は [`docs/decisions/agent-adapter.md`](docs/decisions/agent-adapter.md) を参照。

### Codex support（実験的）

[Codex](https://github.com/openai/codex) をterminal agentとして使用できます。`~/.charminal/config.json` で切り替えます：

```json
{
  "terminalAgent": "codex"
}
```

自動起動・persona prompt overlay・PTY observation・Charminal MCP accessが動作します。`/charm:*` commandは、Codexではカスタムの `/` commandに非対応のため `$charm-*` skillとして登録されます。ただしClaude Code hooksはcross-agent contractとして扱いません。CodexのCharminal reminderはClaudeの `UserPromptSubmit` hook出力ではなく、prompt overlayへの追記として渡します。

---

## Contributing

IssueやDiscussionは歓迎します。**Pull requestは準備中のため、現在受け付けていません。**

セキュリティ報告は [SECURITY.md](SECURITY.md) を参照してください。

---

## Tech stack

- **App shell**: Tauri 2（RustはPTY / hooks / FS / windowのIO層のみ）
- **Runtime**: React 19 + TypeScript 5.8（canonical runtimeはTypeScript側）
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
- [Tauri 2 のplatform依存関係](https://v2.tauri.app/start/prerequisites/)

### Setup

```bash
npm install       # prepare script が lefthook install も走らせる
npm run tauri dev # デスクトップアプリとして起動
```

> **Note:** 一部の asset（VRMA アニメーション、音声 WAV）は third-party 由来でリポジトリに同梱されていません。asset がなくてもアプリは起動しますが、キャラクターのアニメーションと音声が制限されます。
>
> OSS と asset のクレジットは [`CREDITS.ja.md`](CREDITS.ja.md) を参照してください。

### Scripts

| command | 用途 |
|---|---|
| `npm run dev` | Vite dev serverのみ（browser preview用） |
| `npm run tauri dev` | Tauriアプリとして起動 |
| `npm run fmt` | Biome + rustfmtでauto-fix |
| `npm run check` | CI相当のフルゲート（format / lint / clippy） |
| `npm run test` | Vitest（watch） |
| `npm run test:run` | Vitest（one-shot） |
| `npm run test:rust` | `cargo test` |

buildを公開する前のsmoke testには [`docs/release-checklist.md`](docs/release-checklist.md) を使います。

---

## Documentation

### 設定とカスタマイズ

- [`docs/configuration.md`](docs/configuration.md) — `~/.charminal/config.json` のfield一覧
- [`docs/decisions/scene-execution-sandbox.md`](docs/decisions/scene-execution-sandbox.md) — local trusted pack共有とscene実行境界
- [`docs/terminal.md`](docs/terminal.md) — Terminal sessionのprofile / shellカスタマイズ / OSC 133 shell integration

### Development

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — 開発convention（tech stack / coding / workflow）
- [`CREDITS.ja.md`](CREDITS.ja.md) — 使っているOSSとassetのクレジット ([English](CREDITS.md))

### Security

- [`docs/security.md`](docs/security.md) — 信頼境界とattack surfaceの地図
- [`SECURITY.md`](SECURITY.md) — セキュリティポリシーと脆弱性報告

### Philosophy — このプロジェクトの思想

- [`docs/philosophy/PHILOSOPHY.ja.md`](docs/philosophy/PHILOSOPHY.ja.md) — Presence Harness、Inhabited Character Interface、自己言及的MCP、そしてAIに身体が要る理由（意識と反射の二層構造）

### Design record（内部 — 別 repo）

設計判断のrevelations / dry-run results / phase plans / specsは別repo `Charminal-design-record` で管理しています。本repoの親ディレクトリにcloneすると `../Charminal-design-record/` として参照できます。

---

## License

[MIT](LICENSE)

「Charminal」の名称およびロゴは作者の商標であり、MIT ライセンスの対象には含まれません。コードは MIT の条件で自由に fork・再配布できますが、fork に「Charminal」の名称やロゴを用いて出自を誤認させるような使い方はお控えください。

---
