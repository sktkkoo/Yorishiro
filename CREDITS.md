# Credits

Charminal が成り立っているのは、先に作られ、公開され、共有された多くの仕事のおかげです。ここでは Charminal が依存している OSS・仕様・asset をまとめて記録します。

*このドキュメントは生きています。抜け・誤りを見つけたら PR / issue で指摘してください。*

---

## Runtime dependency

### Claude Code

Charminal は [**Claude Code**](https://claude.com/claude-code)（Anthropic）を PTY 経由で起動し、その挙動を観察することで成り立っています。Claude Code 本体は Charminal に同梱されず、ユーザー環境にインストールされたものを呼び出します。

---

## Application stack

### App shell / IO layer

- [**Tauri 2**](https://tauri.app/) — MIT / Apache-2.0
- [**portable-pty**](https://github.com/wez/wezterm/tree/main/pty) — MIT（WezTerm プロジェクト由来）
- [`tauri-plugin-opener`](https://github.com/tauri-apps/plugins-workspace) — MIT / Apache-2.0
- [`tauri-plugin-dialog`](https://github.com/tauri-apps/plugins-workspace) — MIT / Apache-2.0

### UI runtime

- [**React**](https://react.dev/) — MIT
- [**TypeScript**](https://www.typescriptlang.org/) — Apache-2.0
- [**Vite**](https://vitejs.dev/) — MIT

### Terminal

- [**xterm.js**](https://xtermjs.org/) — MIT
- `@xterm/addon-fit` — MIT
- `@xterm/addon-webgl` — MIT

### 3D / VRM

- [**Three.js**](https://threejs.org/) — MIT
- [**@pixiv/three-vrm**](https://github.com/pixiv/three-vrm) — MIT（pixiv Inc.）
- [**@pixiv/three-vrm-animation**](https://github.com/pixiv/three-vrm) — MIT（pixiv Inc.）

### Tooling

- [**Biome**](https://biomejs.dev/) — MIT / Apache-2.0
- [**rustfmt / clippy**](https://github.com/rust-lang/) — MIT / Apache-2.0
- [**Vitest**](https://vitest.dev/) — MIT
- [**Lefthook**](https://github.com/evilmartians/lefthook) — MIT

---

## Specifications

- [**VRM**](https://vrm.dev/) — VRM Consortium
- [**VRMA**](https://vrm.dev/vrma/) — VRM Consortium
- [**glTF 2.0**](https://www.khronos.org/gltf/) — Khronos Group

---

## Bundled assets

VRMA アニメーションと voice WAV は third-party 由来で **git repo に直接同梱することはライセンス的に不可** です（個別ライセンス参照）。一方、Charminal の **配布バンドル（`.app` / `.exe`）** には build 時に組み込まれます — public repo での raw file 二次配布と、アプリ内同梱は別物として扱われます。

開発者向けの asset 配置ワークフローは [`README.md` の Assets セクション](README.md#assets) を参照してください（`../Charminal-assets/` に置いて `npm run fetch-assets` で sync）。

### VRM models（キャラクター本体）

- 配置先: 現状はユーザーが runtime import（`bundled-packs/shared/bodies/` は空 placeholder）
- 同梱方針: **TBD**（default キャラクターを bundle するか、user import 一本で行くか未定）
- **出所**: ユーザー自身の持ち込み。VRoid Studio / Booth / VRM Consortium の sample モデル等
- **License**: 各モデルの license に従ってください。商用利用・改変・再配布の可否はモデルごとに異なります

### VRMA animations

外部 asset ストア（`../Charminal-assets/animations/`）→ build 時に `public/animations/` へ copy → `.app` / `.exe` に bundle、という流れで配布物に含めます。git repo には raw file を置きません。

#### `VRMA_01.vrma` ～ `VRMA_07.vrma`

> **キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト**
> *Character Animation by pixiv Inc. / VRoid Project*

- 出所: [VRMアニメーション7種セット（.vrma） — VRoid Project（BOOTH）](https://booth.pm/ja/items/5512385)
- 利用規約: 個人 / 法人の商用利用可、改変可。**上記クレジットの表記が必須**（アプリの About / クレジット画面で表示する想定）
- **取り出せる状態での再配布は禁止** → public git repo に raw file を置くのは NG。アプリバンドル内に組み込むのは OK（asset pack として単体取り回しできる形ではないため）

#### Mixamo 由来の VRMA 群

`Angry.vrma` / `Button Pushing.vrma` / `Idle.vrma` / `Jog In Circle.vrma` / `Leaning.vrma` / `Right Turn.vrma` / `Talking On Phone.vrma` / `Thankful.vrma` / `Typing.vrma`

- 出所: [Adobe Mixamo](https://www.mixamo.com/) のアニメーションを VRMA 形式に変換したもの
- 利用規約: Mixamo の ToS に従う。サインインしたユーザーが個人 / 商用プロジェクト内で使用可能。ファイル単独の再配布は不可 → public git repo に raw file を置くのは NG、アプリバンドル内同梱は OK

### Voice WAV files

- 配置先: 外部 `../Charminal-assets/voices/` → build 時に `bundled-packs/shared/voices/` へ copy（同 `.gitignore`）
- カテゴリ: `acknowledge/` / `working/` / `thinking/` / `longwork/` / `done/` / `error/`
- **出所**: [VOICEVOX](https://voicevox.hiho.jp/) で録音した開発用 sample
- **配布方針**: ⚠️ **現状の voice WAV は配布バンドルに含めません**。VOICEVOX の利用規約上、配布に適さないため。release ビルドの前に、配布可能な voice 群（自前録音 / 配布許諾済み素材）に差し替える予定です

### Fonts / icons

- Tauri default icon: `src-tauri/icons/` — [Tauri template](https://github.com/tauri-apps/create-tauri-app) 由来（MIT / Apache-2.0）。将来的に Charminal 独自アイコンに差し替え予定

---

## Inspiration / prior art

- Claude Code（Anthropic）— Charminal の宿主
- VRoid / VRM エコシステム（pixiv / VRM Consortium）— キャラクター表現の前提
- 旧 Charminal（self-hosted prototype）— procedural face / 物理落下の実験

---

## Acknowledgements

*Charminal は、上で挙げた仕事に加え、名前を挙げきれない数多くの OSS と asset に依存しています。その全てに感謝します。*
