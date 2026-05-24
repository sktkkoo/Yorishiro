# Credits

Charminal が成り立っているのは、先に作られ、公開され、共有された多くの仕事のおかげです。ここでは Charminal が依存している OSS・仕様・asset をまとめて記録します。

*このドキュメントは生きています。抜け・誤りを見つけたら issue で指摘してください。*

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

VRMA アニメーションは third-party 由来で **git repo に直接同梱することはライセンス的に不可** です（個別ライセンス参照）。一方、Charminal の **配布バンドル（`.app` / `.exe`）** には build 時に組み込まれます — public repo での raw file 二次配布と、アプリ内同梱は別物として扱われます。

開発者向けの asset 配置については `scripts/fetch-assets.mjs` を参照してください。

### VRM models（キャラクター本体）

#### CLAI（同梱デフォルトキャラクター）

キャラクターデザイン・VRMモデル制作：LUCAS（[@lucas_VTuber](https://x.com/lucas_VTuber)）

本モデルの著作権は Charminal プロジェクトに譲渡されています。著作人格権は LUCAS 様に帰属します。

素晴らしいデザインとモデルによって CLAI に命を吹き込んでくださった LUCAS 様に、深く感謝申し上げます。

> LUCAS 様は Charminal プロジェクトとは無関係です。
> 本アプリケーションに関するお問い合わせを LUCAS 様へ行うことはお控えください。

### VRMA animations

外部 asset ストア（`../Charminal-assets/animations/`）→ build 時に `public/animations/` へ copy → `.app` / `.exe` に bundle、という流れで配布物に含めます。git repo には raw file を置きません。

#### `VRMA_01.vrma` ～ `VRMA_07.vrma`

> **キャラクターアニメーション: ピクシブ株式会社 VRoidプロジェクト**
> *Character Animation by pixiv Inc. / VRoid Project*

- 出所: [VRMアニメーション7種セット（.vrma） — VRoid Project（BOOTH）](https://booth.pm/ja/items/5512385)
- 利用規約: 個人 / 法人の商用利用可、改変可。**上記クレジットの表記が必須**（アプリの About / クレジット画面で表示する想定）
- **取り出せる状態での再配布は禁止** → public git repo に raw file を置くのは NG。アプリバンドル内に組み込むのは OK（asset pack として単体取り回しできる形ではないため）

#### Rokoko「10 Free Everyday Idle Animations」

`Idle Arguing.vrma` / `Idle Chatting.vrma` / `Idle Chatting 2.vrma` / `Idle Conversation.vrma` / `Idle Leaning On Wall.vrma` / `Idle Listening To Music.vrma` / `Idle Looking Around.vrma` / `Idle Looking Around 2.vrma` / `Idle Pointing.vrma` / `Idle Watching Something.vrma`

- 出所: [Rokoko — 10 Free Everyday Idle Animations](https://www.rokoko.com/resources/rokoko-mocap-10-free-everyday-idle-animations)（モーションキャプチャ: Sam Lazarus / Marco Mori / Jon Noorlander）
- 利用規約: [Rokoko Studio EULA v2](https://cdn.rokoko.com/legal/rokoko-studio/rokoko_studio_eula_v2.pdf) に従う。完成品内での商用利用可。**raw アニメーションファイルの再配布は禁止** → public git repo に raw file を置くのは NG、アプリバンドル内に組み込んだ状態での配布は OK。EULA に明示的なクレジット表記義務はないが、出所と制作者を courtesy として記載する。
- 備考: 元の FBX ファイルを VRMAConverter で VRMA 形式に変換したもの。

#### Mixamo 由来の VRMA 群

`Angry.vrma` / `Button Pushing.vrma` / `Idle.vrma` / `Jog In Circle.vrma` / `Leaning.vrma` / `Right Turn.vrma` / `Talking On Phone.vrma` / `Thankful.vrma` / `Typing.vrma`

- 出所: [Adobe Mixamo](https://www.mixamo.com/) のアニメーションを VRMA 形式に変換したもの
- 利用規約: Mixamo の ToS に従う。サインインしたユーザーが個人 / 商用プロジェクト内で使用可能。ファイル単独の再配布は不可 → public git repo に raw file を置くのは NG、アプリバンドル内同梱は OK

### Fonts / icons

- Tauri default icon: `src-tauri/icons/` — [Tauri template](https://github.com/tauri-apps/create-tauri-app) 由来（MIT / Apache-2.0）。将来的に Charminal 独自アイコンに差し替え予定

---

## Inspiration / prior art

- Claude Code（Anthropic）— Charminal が身体を与える対象
- VRoid / VRM エコシステム（pixiv / VRM Consortium）— キャラクター表現の前提
- Emacs — ユーザーが拡張する runtime のモデル、`init.el` パターン（`~/.charminal/init.js` はその直系）
- VRChat — UGCと3Dアバターによる交流プラットフォーム。「仮想空間に居る」とは
- [@kensyouen_Y](https://x.com/kensyouen_Y/status/1820748563338637581) — Blender 内のキャラクターが UI をつかんで操作し、パネルを勝手に動かし、自分の髪色まで変えてしまう動画。キャラ自身が自分を含む制作環境を動かすという、ICI への大きなインスピレーション
- [Caramel Pain / 星街すいせい(official)](https://www.youtube.com/watch?v=UpEPkPg8YP4) — イラスト制作ソフトで描かれた星街すいせいがソフトの UI を破壊し、アプリの外に飛び出して暴れ回る MV。こちらも大きなインスピレーション

---

## Acknowledgements

*Charminal は、上で挙げた仕事に加え、名前を挙げきれない数多くの OSS と asset に依存しています。その全てに感謝します。*
