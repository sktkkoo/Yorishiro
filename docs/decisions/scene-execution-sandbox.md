# Scene execution sandbox and local trusted sharing

> このファイルは「**scene / shader pack で VRM と背景 3D を同じ空間に置きたい時、sandbox と性能と配布をどう扱うか**」を考える時に読む。対象：dev / AI / pack 作者。

**Status**: active（MVP stance）
**Last updated**: 2026-05-19

## TL;DR

MVP では Emacs と同じ local trusted model を採る。GitHub 等で共有された pack は public-registry artifact ではなく、user が `~/.yorishiro/packs/` に置いて実行する **local trusted code** である。

VRM と背景 3D の真の遮蔽 / 共有 lighting / depth 統合が必要な scene は、sandboxed community pack ではなく `trusted-main-thread-js` として host renderer の同一 scene / 同一 WebGL context に入れる。sandboxed public distribution は future の別設計として残す。

## 何を決めたか

### 1. MVP の pack 共有は local trusted

現時点の Yorishiro には public pack registry、in-app community pack install、`/yori:prepare-publish` が無い。したがって MVP で GitHub 等を通して共有される pack は、審査済み community artifact ではなく **local trusted pack の非公式共有** として扱う。

導入した user は、pack source を読んだ上で自分の `~/.yorishiro/packs/<pack-id>/` に置く。これは Emacs の elisp package / `init.el` に近い trust model であり、sandbox 安全性ではなく user の明示的な local trust に依存する。

### 2. VRM と背景 3D の真の統合は `trusted-main-thread-js`

VRM と背景モデルが互いに遮蔽し、同じ lighting / camera / depth buffer を共有するには、同じ renderer / scene / WebGL context に入る必要がある。

現行 ThreeRuntime は host が renderer / scene / camera / RAF / resize を所有し、R3F は `<Canvas>` を使わず custom root で同じ scene graph に参加する。bundled `abandoned-factory` 級の true depth integration はこの構造で成立する。

MVP では、この品質が必要な scene pack は `trusted-main-thread-js` として扱う。source が `local` なら user の自己責任、`bundled` / `curated` なら Yorishiro 側の責任で review する。`community` source の `trusted-main-thread-js` を安全表示して配布することはしない。

### 3. `isolated-js` scene は将来も自己完結レイヤーを default にする

将来 `isolated-js` scene を実装する場合、default は Worker + OffscreenCanvas + SES の自己完結 scene とする。pack は独立 canvas layer に描画し、host が描く VRM とは depth buffer を共有しない。

この形は custom shader / post-process / Three.js code の自由度を持ちながら、Worker boundary と capability RPC で public distribution に近づけるための設計である。ブラウザ合成に任せられる限り、host との毎フレーム frame transfer は不要で、処理負荷も読みやすい。

### 4. Worker 側に VRM も描かせる案は MVP から外す

Tier 2 で真の深度統合を取り戻す別案として、「host が VRM asset / pose / expression / motion state を sandbox Worker に渡し、Worker 内で背景と VRM を一緒に描く」案を検討した。

これは不可能ではないが、MVP では採らない。理由は以下：

- VRM は単なる GLB ではなく、bone pose、blendshape、視線、spring bone、motion、IK、material、lighting などを毎フレーム扱う身体 runtime である。
- user の VRM asset / texture / material 情報を community scene sandbox に渡す capability 面が増える。
- SharedArrayBuffer を使わない前提では、pose / morph / camera / lighting の同期は `postMessage` になり、低負荷設計ではない。
- 身体の最終描画を scene pack 側 Worker に移すため、Yorishiro の body runtime と scene runtime の所有境界が割れる。
- host VRM と Worker scene の cross-context depth merge はできない。真の統合を得るには、結局 VRM 自体を Worker 側で描く必要がある。

この案は「自由な JS + sandbox + true character integration」を同時に狙う将来研究としては残すが、MVP の配布 / README / pack 作者向け案内には入れない。

## なぜそう決めたか

### Emacs model が MVP の実態に合っている

Emacs package は基本的に Emacs process と同じ権限空間で動く。強い runtime sandbox ではなく、user がその elisp を信頼して入れることで成立している。

Yorishiro の current user pack も同型である。`~/.yorishiro/packs/` に置かれた JS は local trusted code として WebView runtime に参加する。まだ public registry / checker / review chain / sandboxed install UX が無い段階で、これを community-safe と呼ばない方が責任境界が明確になる。

### 低負荷で true depth integration するなら single renderer が最短

VRM と背景 3D を同じ空間に見せるだけなら layer 合成でも足りる。しかし、柱の裏にキャラが隠れる、床やオブジェクトとの前後関係が正しく出る、lighting を共有する、といった表現には single renderer / single depth buffer が必要になる。

local trusted scene を host renderer に入れる方式なら、毎フレーム Worker RPC や frame copy が不要で、既存 ThreeRuntime の single active scene 設計とも合う。処理負荷を最小化しながら表現品質を取る MVP 解である。

### public distribution は別問題として残す

「GitHub で source を共有できる」と「Yorishiro が安全な community distribution として扱う」は違う。後者には `pack-execution-classes.md` の declarative / isolated-js / trusted-main-thread-js、source classification、registry integrity model、permission diff、checker が必要である。

MVP は前者だけを documentation で案内し、後者は future public registry の設計として残す。

## 検討したが却下した代替案

- **GitHub 共有 pack を community-safe と呼ぶ** — sandbox / review / registry integrity が無いのに安全配布扱いになる。却下。
- **MVP から isolated-js scene を必須にする** — OffscreenCanvas + SES + capability RPC + watchdog + recovery + permission UX が必要で、現行 pack 配布機能の実態より重い。却下。
- **isolated-js で VRM も Worker 側に描かせる** — true depth integration は得られるが、身体 runtime の同期面と asset/capability 面が大きい。MVP から外す。
- **host が sandbox canvas の depth を取り込んで merge する** — browser canvas / WebGL context 間で depth buffer を直接共有できない。color texture として再合成するだけでは真の遮蔽にならず、frame copy と 1 frame latency も発生する。却下。
- **visual impersonation / なりすまし対策を security control として戻す** — Yorishiro は単一ユーザー・ローカルアプリで、破壊操作は host approval UI で gate する。scene の描画分離は security ではなく layout / performance / distribution の問題として扱う。

## この決定の implication / 制約

- README / pack 作者向け docs では、GitHub 等で共有された pack を「local trusted code」「自己責任」と明記する。
- `~/.yorishiro/packs/<pack-id>/` へ手動配置する導入方法は書いてよい。ただし public registry / in-app community install があるように書かない。
- `npm run check:pack` は debugging / sharing 前の local checker であり、sandbox や安全審査の代替ではない。
- VRM と背景 3D の完全な depth integration を要求する user scene は、MVP では `trusted-main-thread-js` として扱う。
- future public registry では、`declarative` scene を host renderer data として読み込む方向が、低負荷 + true depth integration の本命候補になる。自由な JS / custom shader を許す `isolated-js` scene は自己完結 layer が default。
- `isolated-js` の Worker-VRM rendering 案は future research として残すが、MVP の spec / README では推奨経路にしない。

## 関連 reference

- 関連: [`pack-execution-classes.md`](pack-execution-classes.md)、[`mcp-trust-tiers.md`](mcp-trust-tiers.md)、[`user-pack-layout.md`](user-pack-layout.md)、[`pack-override-pattern.md`](pack-override-pattern.md)
- Security map: [`../security.md`](../security.md)
- R3F host integration memory: `project_r3f_migration_abandoned.md`
- current true-depth example: `bundled-packs/scenes/abandoned-factory/`
- host runtime: `src/runtime/three-runtime/three-runtime.ts`
- internal design-record: 2026-05-19-scene-execution-sandbox-and-local-trusted-sharing.md

## 改訂履歴

- 2026-05-19: 初版。scene / shader pack の sandbox 議論を MVP 方針として整理。Emacs 的 local trusted sharing を採り、GitHub 等の pack 共有は `~/.yorishiro/packs/` への自己責任導入として document する。`isolated-js` scene は future public distribution 用の自己完結 layer、Worker 側 VRM rendering は MVP 外とした。
