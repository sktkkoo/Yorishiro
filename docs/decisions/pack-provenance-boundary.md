# Pack provenance and the local-trusted-code boundary

> このファイルは「**手元に置いた pack をどこまで信頼するか / provenance をどの層で強制するか**」を考える時に読む。対象：dev / AI / セキュリティレビュー。

**Status**: active
**Last updated**: 2026-07-11

## TL;DR

ユーザーが手で `~/.yorishiro/packs/` に置いた pack は **local trusted code**（エディタ拡張・シェルスクリプト・Emacs パッケージと同格）として扱う。インストールとは、自分の権限でコードを走らせることを選ぶ行為である。現行 release には**第三者配布の経路が存在しない**（install コマンド・ダウンロード導線・稼働中の registry のいずれも無い）。したがって「pack の来歴（provenance）を実行時にゲートするセキュリティ機構」は**あえて実装しない**。真正性・来歴の強制は、脅威面が初めて生まれる**配布層（store の署名チェーン）**に置く。

## Context

Pack は本体と同じ WebView realm で動き、`window.__TAURI_INTERNALS__` 経由で `system_exec`（任意 `sh -c`）を含む全 Tauri IPC に到達できる。SDK（`ctx.*`）は *supported* な authoring surface であって *enforced* な sandbox ではない。これは [`pack-execution-classes.md`](pack-execution-classes.md) / [`scene-execution-sandbox.md`](scene-execution-sandbox.md) / [`system-exec-trust-model.md`](system-exec-trust-model.md) に記した「local trusted code」スタンスの帰結である。

`pack-execution-policy.ts` には `community` / `curated` source を排除する分岐が存在するが、discovery が全 pack に `source: "local"` を割り当てる現状では**到達不能な forward-scaffolding**である（[`../security.md`](../security.md) の "Current enforcement status" 参照）。この文書は、その分岐を「実装済みの安全境界」として**扱わない**ことを明文化する。

## Decision

1. **手で置いた pack = local trusted code。** インストールする＝自分のシェルと同じ権限でコードを走らせることを選ぶ、と明示する。境界は「実行時ゲート」ではなく「ユーザーが置いたという provenance（社会的境界）」である。VS Code 拡張 / Obsidian community plugin / シェルスクリプトと同じモデル。

2. **id ベースの provenance を実行時セキュリティゲートとしては実装しない。** pack の来歴を pack の id（＝ディレクトリ名）で判定して信頼/非信頼を分けるゲートは、**堅牢な安全境界にならない**ため採用しない。理由：
   - **id は人間可読で推測可能**（`my-room`, `simple-room-shadow` 等）。攻撃者は「ユーザーが作りそうな id」を狙って信頼済み id に衝突させられる。
   - **pack が提示するトークンは共有で漏れる。** pack は共有される前提の成果物なので、pack 内（manifest 等）に置いた鍵は、pack を配った瞬間に漏れ、コピーで偽造できる。「pack 自身の自己申告 source を信じない」原則の裏返し。
   - **中身のハッシュに縛ると編集が壊れる。** 住人 AI とユーザーは packs/ を日常的に編集する。content-hash 束縛は編集のたびに信頼を失わせ、ワークフローと両立しない。
   - 弱いのに"公式に見える"ゲートは**誤った安心（false confidence）**を生み、実際の保護以上のものを主張してしまう。

3. **真正性・来歴の強制は配布層に defer する。** pack store / install 経路が存在するとき、pack は store の**署名チェーン**（Ed25519 descriptor 署名 + sha256 ピン）で検証し、store 由来 pack を編集したら **local fork に降格**する（ELPA stance）。そこが untrusted-input の脅威面が初めて生まれる場所であり、**偽造不能な per-install identity** を割り当てられる場所でもある。設計は [`pack-execution-classes.md`](pack-execution-classes.md) の registry / 署名要件に従う。

## Consequences

- 配布経路が存在しない間、手元の pack はすべて trusted として扱う。安全境界は「ユーザーの設置という provenance」であって「実行時ゲート」ではない。
- `pack-execution-policy.ts` の `community` / `curated` 分岐は forward-scaffolding のまま残し、**「稼働中の control」として提示してはならない**（doc / コメント / リリースノートで誇張しない）。
- 将来 install / 配布経路を作るときは、次を満たすこと（これらが揃うまで provenance ゲートを "安全機能" と呼ばない）：
  - **provenance は受信側（Yorishiro）が install 時に割り当てる。** pack の自己申告 source を信じない。
  - **信頼の識別子は人間 id ではなく、opaque な per-install identity。** マシンをまたがず共有されない住所にすることで、id 推測攻撃を無効化する。
  - **中身の真正性は署名で担保。** 編集は local fork 降格で検出する。

## Alternatives considered / rejected

- **id ベース provenance ledger を安全ゲートとして出荷** — 却下。上記 Decision 2 の理由（推測可能な id・共有での鍵漏れ・編集との非両立）で堅牢な境界にならない。実装は探索ブランチ `feat/pack-provenance-ledger` に存在するが、**安全境界としては棚上げ**する（将来、非セキュリティな provenance/UX ヒント、または install 時 provenance の出発点として転用する余地はある）。
- **content-hash ゲート** — 却下。ユーザー / 住人 AI の日常編集を壊す。
- **opaque per-install id を今すぐ導入** — 却下（時期尚早）。install 経路が無い現段階では「扉の無い場所に鍵を付ける」状態で、pack layout（ディレクトリ名 = 人間 id、`config.json` の `activeScene` 等の参照）への重い refactor が gain に見合わない。opaque id は install 経路とセットで初めて意味を持つ。

## Related

- [`pack-execution-classes.md`](pack-execution-classes.md) — executionClass / 公開配布の署名・registry 要件
- [`system-exec-trust-model.md`](system-exec-trust-model.md) — `system_exec` の信頼モデル
- [`bundled-pack-immutability.md`](bundled-pack-immutability.md) — bundled は本体の一部（別境界）
- [`../security.md`](../security.md) — enforcement status の一次記述
