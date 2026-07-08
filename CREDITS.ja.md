# Credits

Yorishiro が成り立っているのは、先に作られ、公開され、共有された多くの仕事のおかげです。ここでは Yorishiro が依存している OSS・仕様・asset をまとめて記録します。

*このドキュメントは生きています。抜け・誤りを見つけたら issue で指摘してください。*

---

## Runtime dependency

### Claude Code

Yorishiro は [**Claude Code**](https://claude.com/claude-code)（Anthropic）を PTY 経由で起動し、その挙動を観察することで成り立っています。Claude Code 本体は Yorishiro に同梱されず、ユーザー環境にインストールされたものを呼び出します。

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
- [**React Three Fiber**](https://github.com/pmndrs/react-three-fiber) — MIT（Poimandres）
- [**@react-three/drei**](https://github.com/pmndrs/drei) — MIT（Poimandres）
- [**@react-three/postprocessing**](https://github.com/pmndrs/react-postprocessing) — MIT（Poimandres）
- [**@pixiv/three-vrm**](https://github.com/pixiv/three-vrm) — MIT（pixiv Inc.）
- [**@pixiv/three-vrm-animation**](https://github.com/pixiv/three-vrm) — MIT（pixiv Inc.）

### Debug / Tuning UI

- [**leva**](https://github.com/pmndrs/leva) — MIT（Poimandres）

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

VRMA アニメーションは third-party 由来で **git repo に直接同梱することはライセンス的に不可** です（個別ライセンス参照）。一方、Yorishiro の **配布バンドル（`.app` / `.exe`）** には build 時に組み込まれます — public repo での raw file 二次配布と、アプリ内同梱は別物として扱われます。

開発者向けの asset 配置については `scripts/fetch-assets.mjs` を参照してください。

### VRM models（キャラクター本体）

#### CLAI（同梱デフォルトキャラクター）

キャラクターデザイン・VRMモデル制作：LUCAS（[@lucas_VTuber](https://x.com/lucas_VTuber)）

本モデルの著作権は Yorishiro プロジェクトに譲渡されています。著作人格権は LUCAS 様に帰属します。

**ライセンス（CLAI.vrm のメタデータに埋め込み）:** Yorishiro 上での利用は全員に許可。モデル単体の再配布・利用は禁止。暴力表現は許可、性的表現は禁止。これらの条件は VRM 自身の license メタ（`licenseName: Other`、`violentUssageName: Allow` / `sexualUssageName: Disallow` / `commercialUssageName: Allow`）に記録されており、アプリ内の Credits 画面にも表示されます。

CLAI というキャラクターの利用（ファンアート・クリップ・配信など）については [`CHARACTER_GUIDELINES.ja.md`](CHARACTER_GUIDELINES.ja.md) を参照してください。

素晴らしいデザインとモデルによって CLAI に命を吹き込んでくださった LUCAS 様に、深く感謝申し上げます。

> LUCAS 様は Yorishiro プロジェクトとは無関係です。
> 本アプリケーションに関するお問い合わせを LUCAS 様へ行うことはお控えください。

### VRMA animations

外部 asset ストア（`../Yorishiro-assets/animations/`）→ build 時に `public/animations/` へ copy → `.app` / `.exe` に bundle、という流れで配布物に含めます。git repo には raw file を置きません。

#### `VRMA_01.vrma` ～ `VRMA_07.vrma`

> **キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト**
> *Character animation credits to pixiv Inc.'s VRoid Project*

- 出所: [VRMアニメーション7種セット（.vrma） — VRoid Project（BOOTH）](https://booth.pm/ja/items/5512385)
- 利用規約: 個人 / 法人の商用利用可、改変可。**上記クレジットの表記が必須**（アプリの About / クレジット画面で表示する想定）
- **取り出せる状態での再配布は禁止** → public git repo に raw file を置くのは NG。アプリバンドル内に組み込むのは OK（asset pack として単体取り回しできる形ではないため）

#### Rokoko「10 Free Everyday Idle Animations」

`Idle Arguing.vrma` / `Idle Chatting.vrma` / `Idle Chatting 2.vrma` / `Idle Conversation.vrma` / `Idle Leaning On Wall.vrma` / `Idle Listening To Music.vrma` / `Idle Looking Around.vrma` / `Idle Looking Around 2.vrma` / `Idle Pointing.vrma` / `Idle Watching Something.vrma`

- 出所: [Rokoko — 10 Free Everyday Idle Animations](https://www.rokoko.com/resources/rokoko-mocap-10-free-everyday-idle-animations)（モーションキャプチャ: Sam Lazarus / Marco Mori / Jon Noorlander）
- 利用規約: Rokoko の **Rokoko Asset** ライセンス条項（[Rokoko の利用規約](https://support.rokoko.com/hc/en-us/articles/29449288418065-Rokoko-Vision-Terms-of-Use)に記載）に従う。**Rokoko Studio ソフトウェア EULA**（[PDF](https://cdn.rokoko.com/legal/rokoko-studio/rokoko_studio_eula_v2.pdf)）**ではない** — あれは Studio アプリ本体の利用規約で、アセット再配布については何も定めていない。自分のプロジェクト内での商用利用可。アセットを**単体で複製・配布・サブライセンス・貸与することは不可**だが、**デジタルメディア制作物に統合した場合のコピーは明示的に許可**されている。アセットのライセンスは**Rokoko アカウントを保有している期間に限定**される。クレジット表記義務はないが、出所と制作者を courtesy として記載する。Yorishiro では VRMA を loose file として配布せず、Tauri の `frontendDist` 経由でアプリ実行バイナリにコンパイル埋め込みする（`asset://` 経由で再生のみ、ファイル単体としては取り出せない）ため、これは「デジタルメディア制作物への統合」に該当し、単体再配布には当たらない。配布を続ける間は Rokoko アカウントを維持しておくこと。
- 備考: 元の FBX ファイルを VRMAConverter で VRMA 形式に変換したもの。

#### Mixamo 由来の VRMA 群

`Angry.vrma` / `Button Pushing.vrma` / `Idle.vrma` / `Jog In Circle.vrma` / `Leaning.vrma` / `Right Turn.vrma` / `Talking On Phone.vrma` / `Thankful.vrma` / `Typing.vrma`

- 出所: [Adobe Mixamo](https://www.mixamo.com/) のアニメーションを VRMA 形式に変換したもの
- 利用規約: Mixamo の ToS に従う。サインインしたユーザーが個人 / 商用プロジェクト内で使用可能。ファイル単独の再配布は不可 → public git repo に raw file を置くのは NG、アプリバンドル内同梱は OK

### Sound

scene pack から `sound:<name>` で参照する同梱 ambient 音源。ファイル単位の一覧と license は [`bundled-packs/shared/sounds/README.md`](bundled-packs/shared/sounds/README.md) で管理する。

- `calming-rain.mp3` — [Pixabay](https://pixabay.com/) — [Pixabay Content License](https://pixabay.com/service/license-summary/)（帰属不要・商用利用可）
- `bundled-packs/scenes/abandoned-factory/assets/abandoned-factory_piano-loop.mp3` — "Piano Loops 208 Octave Up Short Loop 120 BPM"（josefpres）— [freesound.org](https://freesound.org/people/josefpres/sounds/852739/) — [CC0 1.0 Universal](https://creativecommons.org/publicdomain/zero/1.0/)（パブリックドメイン）。ファイル単位の条項は [`bundled-packs/scenes/abandoned-factory/assets/LICENSE`](bundled-packs/scenes/abandoned-factory/assets/LICENSE) にも記録。

CLAI の事前収録ボイスは本リリースでは同梱していません。

### Fonts / icons

- Tauri default icon: `src-tauri/icons/` — [Tauri template](https://github.com/tauri-apps/create-tauri-app) 由来（MIT / Apache-2.0）。将来的に Yorishiro 独自アイコンに差し替え予定

---

## Inspiration / prior art

これらの作品が Yorishiro の方向を示してくれました。

- Claude Code（Anthropic）— Yorishiro が身体を与える対象
- VRoid / VRM エコシステム（pixiv / VRM Consortium）— キャラクター表現の前提
- Emacs — ユーザーが拡張する runtime のモデル、`init.el` パターン（`~/.yorishiro/init.js` はその直系）
- VRChat — UGCと3Dアバターによる交流プラットフォーム。「仮想空間に居る」とは
- [@kensyouen_Y](https://x.com/kensyouen_Y/status/1820748563338637581) — Blender の中のキャラクターが UI をつかみ、パネルを動かし、自分の髪色を変える。一本の動画で、キャラクターは自分を含む環境そのものを操作できるのだと示してくれた素晴らしい作品。
- [Caramel Pain / 星街すいせい(official)](https://www.youtube.com/watch?v=UpEPkPg8YP4) — イラスト制作ソフトの中に描かれた星街すいせいさんが UI を突き破り、アプリの外へ飛び出す。キャラクターは自分の枠に収まらなくていい — そしてその境界を越える瞬間にこそ生命が宿ることに気づかせてくれた、圧巻の MV。

---

## Acknowledgements

*Yorishiro は、上で挙げた仕事に加え、名前を挙げきれない数多くの OSS と asset に依存しています。その全てに感謝します。*
