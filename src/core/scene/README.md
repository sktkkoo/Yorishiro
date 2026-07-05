# Scene — 住人に「居る場所」を持たせる

このドキュメントは Yorishiro の scene を自分で変える user / pack 作者（あるいはその依頼を受けた AI）が読むためのガイド。**scene を書く前に必ず読む**。

---

## scene とは何か

`PHILOSOPHY.md`「UI は環境である」の実体化。住人（VRM）が**どういう場に居るか**を決める layer stack。複数レイヤーによる合成処理を使うが、目的は「一枚の構図を綺麗に見せる」ことではない：

- 映像作品の layer stack の目的：**一枚の構図を綺麗に見せる**（frame）
- Yorishiro の目的：**住人がその場に居る実在感を増幅する**（place）

この違いが design compass になる。詳細は後半「設計 compass」で。

---

## 現時点の状態 (Phase 1)

**できること:**

- `Layer` の stack を宣言して、背景 / 住人 / 前景の 3 層を compose
- 各 layer に独立した **CSS filter blur** を掛ける（被写界深度 DoF 表現）
- 画像 / 動画を `src` で layer の content に置く
- CSS gradient を `backgroundImage` で置く
- runtime 内蔵 Three.js renderer を `procedural` layer として置く

**まだできないこと（Phase 2 以降）:**

- terminal 状態に応じて色や blur が変わる ambient binding（β channel）
- Auto Color Correction（背景基準で前景を染める）
- Camera filter（diffusion / glow 等）

scene を試すには bundled / user scene pack を登録し、`~/.yorishiro/config.json` の `activeScene` で選ぶ。config が空なら bundled `simple-room` が fallback になる。

---

## Scene の data model

### SceneSpec

```typescript
interface SceneSpec {
  readonly id: string;
  readonly layers: ReadonlyArray<Layer>;
}
```

`layers` は**先頭が一番奥**、末尾が一番手前。layer はすべて `position: absolute; inset: 0` で親を覆い、DOM 順で上に重なっていく。ただし `role: "foreground"` は「住人の手前」という意味を優先し、character canvas より前に出る default z-index を持つ。

### Layer

```typescript
interface Layer {
  readonly id: string;
  readonly role?: "background" | "character" | "foreground";
  readonly src?: string;
  readonly mediaType?: "image" | "video";
  readonly procedural?: { readonly kind: "radiant-meadow" };
  readonly backgroundColor?: string;
  readonly backgroundImage?: string;
  readonly blur?: number;
}
```

| field | 役割 | 備考 |
|---|---|---|
| `id` | layer の識別子 | `data-layer-id` attribute として DOM に出る（debug 用）|
| `role` | compositor の特殊扱い | 下表参照。指定しなくてよい。指定しない layer は単に順に積まれる |
| `src` | 画像 / 動画の path | 拡張子から `<img>` / `<video>` を自動判定。`object-fit: cover` で layer を満たす |
| `mediaType` | `src` の種類 | blob URL など拡張子判定できない時に `"image"` / `"video"` を明示する |
| `procedural` | runtime 内蔵 renderer | `{ kind: "radiant-meadow" }` など。scene は declarative のまま、描画コードは runtime 側に閉じる。`src` と併用しない |
| `backgroundColor` | CSS background-color | 単色の layer を作るとき |
| `backgroundImage` | CSS background-image | `linear-gradient(...)` や `url(...)` を書く。gradient 用途が中心 |
| `blur` | CSS `filter: blur(Xpx)` | per-layer 独立。`0` を明示すると「ぼかさない」を強制（親由来の blur を上書き）、未指定なら filter property 自体を発行しない |

### Role の 3 種

| role | 意味 | 枚数 |
|---|---|---|
| `background` | 住人の奥。Phase 2 で Auto Color Correct の光源になる予定 | 0 or 1 |
| `character` | **VRM slot**。compositor が runtime から VRM canvas を差し込む。src / backgroundColor / backgroundImage は**通常 undefined** | 0 or 1（通常 1） |
| `foreground` | 住人の手前。vignette、カーテン、窓枠など。default で character canvas より前に描画される | 0 or 1 |

role を持たない layer は好きなだけ追加できる（粒子 video、haze、overlay など）。compositing の特殊処理（blur target、auto color correct）が効くのは **role を持つ layer のみ**。

---

## scene の書き方 — 実例

### 最小構成（VRM だけ、背景なし）

```typescript
const scene: SceneSpec = {
  id: "minimal",
  layers: [
    { id: "vrm-slot", role: "character", blur: 0 },
  ],
};
```

### 動画背景 + 浅い DoF + vignette 前景

```typescript
const scene: SceneSpec = {
  id: "video-backdrop",
  layers: [
    {
      id: "backdrop",
      role: "background",
      src: "/assets/my-backdrop.mp4",
      blur: 3,
    },
    { id: "vrm-slot", role: "character", blur: 0 },
    {
      id: "fg-vignette",
      role: "foreground",
      backgroundImage:
        "radial-gradient(ellipse at 50% 60%, transparent 60%, rgba(0, 0, 0, 0.35) 100%)",
      blur: 0,
    },
  ],
};
```

動画は `autoplay muted loop playsInline` で自動再生される。loop video は `spec §4.4 autonomous motion`（場が自律的に動いている気配）の最も手軽な実装手段。

### Gradient 背景（asset なしで試したい時）

```typescript
{
  id: "backdrop",
  role: "background",
  backgroundImage:
    "radial-gradient(ellipse at 50% 30%, rgba(120, 150, 200, 0.18) 0%, transparent 70%), linear-gradient(180deg, #232838 0%, #161a24 100%)",
  blur: 0, // gradient は既に滑らかなので blur を掛けても見た目はほぼ変わらない
}
```

**注意:** gradient に blur を掛けても視覚的変化はほぼ出ない（元々 high frequency detail がないため）。blur の効きを確認したければ、**detail のある画像か動画**を置くこと。

### Procedural 背景（runtime 内蔵 renderer）

```typescript
{
  id: "radiant-meadow-three",
  role: "background",
  procedural: { kind: "radiant-meadow" },
}
```

`procedural` は Scene Pack の宣言から renderer を選ぶための最小 hook。pack 内に Three.js 実行コードを持たせず、renderer の lifecycle / RAF / dispose は runtime 側で管理する。現時点の bundled 実装は `radiant-meadow` のみ。

### 役割を持たない layer（中間の粒子など）

```typescript
{
  id: "dust",
  src: "/assets/dust-particles.webm",
  // role 指定なし → 単に宣言順の位置に積まれる
  blur: 2,
}
```

---

## 設計 compass — 実在感 first, 演出 second

（spec §2.3 / feedback memory `feedback_yorishiro_presence_over_spectacle.md`）

**Default の見た目は整える**。整った polish は出して良い。でも polish の**方向**には注意する：

| ✅ 推奨（実在感を強める） | ❌ 避ける（演出に振れる） |
|---|---|
| 控えめな blur で奥行きを出す | 強い glow で絵が映画風になる |
| 静かで低彩度の背景 | 濃い色の flashy な背景 |
| 微細な揺らぎ (loop video、grain) | 大きな autonomous motion |
| 落ち着いた color tone | 蛍光色 / ネオン |
| 住人が浮かない程度の DoF | VRM がピント外れになるほどの blur |

「居ることを強めたか、演出に見えたか」が唯一の compass。後者寄りなら削ぐ。

### 強い効果の使い所

激しい shake / 濃いカラーキャスト / 大きな glow は「恒常 ambient」には乗せない。**特定の瞬間**（イタズラ、明確な event）専用にする。普段から鳴っていると「敏感すぎるセンサーの下に居る」疲労感になる。

---

## 感触を探る流れ

感触で決まる値（blur の強度、gradient の彩度、動画の動き）は spec に数値を焼かない方針（memory `feedback_inductive_tuning_params.md`）。**動かして観察 → 調整**する。

### Phase 1 で試す手順

1. 素材を用意して `public/` 以下に置く（例: `public/bg-test.mp4`）
   - `public/bg-test.*` は `.gitignore` 済（local-only の前提）
2. `src/App.tsx` の `stubScene` を編集：
   ```typescript
   {
     id: "backdrop",
     role: "background",
     src: "/bg-test.mp4",
     blur: 3, // ここの数字を動かす
   }
   ```
3. `npm run tauri dev`（または reload）で動作確認
4. blur 値 / 背景 / vignette を何度か入れ替えて「落ち着いているか」「住人が浮いていないか」を自分の目で判断

### 観察軸

- 住人はこの場に**居る**感触があるか（浮いていないか、取って付けたようにみえないか）
- 作業の邪魔になっていないか（sidebar は視界の端にあるので、強すぎる motion は NG）
- 長時間見ていて疲れないか

---

## interaction surface — 今は β ambient のみ（Phase 3）

`user と character の通信は terminal 経由` が基本（spec §2.4）。scene 自体に VRM click / hover / parallax のような GUI 入力を**型レベルで設けていない**（ただし MVP scope 判断であって哲学的禁則ではない）。

Phase 3 で terminal 状態（body state / error / time of day）を scene の camera / per-layer parameter に binding する `ambient channel` が入る予定。その時点で「静かな時は色温度が落ちる」「エラーで部屋の空気が一瞬緊張する」のような振る舞いが **pack-declared** で書けるようになる。

Phase 1 の scene は ambient 非対応なので、pack が宣言した値で**固定**動作する。

---

## Phase 2 以降の展望

### Scene pack file（Phase 2）

```
~/.yorishiro/packs/scenes/my-room/
├── manifest.json        # { type: "scene", id, version, ... }
├── scene.ts             # SceneSpec を export default
├── assets/              # 画像 / 動画
│   ├── backdrop.mp4
│   └── window-frame.png
└── README.md
```

現在の `stubScene` と同じ `SceneSpec` を export するだけで pack 化できる予定。asset path は pack-relative になる。

### Ambient channel（Phase 3）

```typescript
export default {
  id: "my-room",
  layers: [...],
  ambient: {
    bindings: [
      {
        signal: "body.state",
        target: "layers.backdrop.blur",
        mapping: { idle: 3, thinking: 4, reading: 2, writing: 2, running: 3 },
      },
      {
        signal: "error",
        target: "layers.backdrop.tint",
        envelope: { attackMs: 200, decayMs: 3000 },
      },
    ],
  },
} satisfies ScenePackManifest;
```

user は設定で ambient 全体を on/off できる。

---

## 関連

- Philosophy: `docs/philosophy/PHILOSOPHY.md`「UI は環境である」「生きた系」「Presence が立ち上がる三つの条件」
- Spec: `specs/2026-04-18-scene-pack-compositor-design.md`（外部 repo `Yorishiro-design-record`）
- SDK guide: `src/sdk/README.md` — 4 種類の Pack（Persona / Harness / Effect / Scene）の書き方を集約。Scene Pack section は manifest / scene.ts shape / active 選択の流れを扱う
