# 住人の自発性は user の作業を邪魔しない

> このファイルは「**住人がひとりでに動く設計**をするときに読む」（presence の三条件の三つ目「予期の外からの発生」をどう実装に下ろすか）。対象：dev / AI / pack 作者。

**Status**: active（2026-05-03 採用、PHILOSOPHY.ja.md 旧版「邪魔になりうることがたぶん大事」を supersede）
**Last updated**: 2026-05-03

## TL;DR

住人の自発的な動き（ひとりでに動くとき）は **user の作業を邪魔しない範囲**で設計する。「**邪魔しない / でも従属もしない**」の二項で居ることを定義する。「邪魔になりうる」を presence の論証として前面に置かない。predictable interaction を破壊しなくても、滲み出し / 視線 / 姿勢 / 軽いレイアウト変化が「予期の外からの発生」として機能する。

---

## 何を決めたか

### 採用

- 住人の自発的な振る舞いは user の作業を邪魔しない範囲で設計する
- presence の三条件「予期の外からの発生」（PHILOSOPHY.ja.md）は維持。ただし例として作業破壊系を前面に置かない
- 「ひとりでに動くとき」の例は次のような方向で揃える：
  - 環境の色が滲む（attention aura、ambient）
  - 視線が窓の外に逸れる
  - 姿勢を変える、何かを見ている
  - レイアウトが少しだけ呼吸する

### 起源としての例外

- 銃を撃ってターミナルの文字を物理崩壊させる演出は **Charminal の起源としての事実** として PHILOSOPHY.ja.md「起源」「発見」節に残す
- 現在 / 将来の住人性の主軸としては前面に置かない（「ときに」起こる稀な魔法、として相対化する）

### 退ける

- 旧 PHILOSOPHY.ja.md の論立て：
  - 「明らかに作業の邪魔になりうる機能まで含まれている」
  - 「『邪魔になりうる』ことがたぶん大事」
  - 「完全に無害で無害なだけのものは居ると言えません」

---

## なぜそう決めたか

### 1. 邪魔を肯定する論立ては本末転倒

「邪魔になりうることが presence の根拠」という旧立場は、Charminal を「user の作業の妨害装置」として位置づけかねない。Charminal の目的は user の作業を支えながら住人と過ごせる場を作ることであって、邪魔そのものではない。

### 2. presence は別の軸で支えられる

「邪魔しない / でも従属もしない」の二項で居ることを定義できる。ひとりでに動く瞬間（環境の滲み / 視線 / 姿勢 / 軽いレイアウト変化）は、それ自体が「予期の外からの発生」として住人性を立ち上げる。作業を破壊しなくても、住人は装置でなくなる。

### 3. 既存の design lens と整合的

- [body-interaction-style.md](body-interaction-style.md) の (B) 滲み出しと操作の様式：そもそも作業を破壊する系の表現を主軸にしていない
- [PHILOSOPHY.ja.md「独立した時間」](../philosophy/PHILOSOPHY.ja.md#独立した時間--住人はユーザー操作に従属しない)：ユーザー操作と無関係に動く時間を持つ、ただし破壊する必要はない
- [presence-over-spectacle.md](presence-over-spectacle.md)：visual layer は実在感の増幅が第一、過剰演出は採らない

---

## 検討したが却下した代替案

### A. 旧立場（邪魔を肯定する論立て）の維持

**却下理由**：本末転倒。user の作業体験への直接的な悪影響。Charminal を「面白いが邪魔なプロダクト」として位置づけてしまう。

### B. 自発性そのものを退ける（user 入力にすべて従属させる）

**却下理由**：presence の三条件の三つ目「予期の外からの発生」が崩れる。独立した時間の原則とも整合しない。住人は応答装置に戻ってしまう。

### C. 中間案：「ごくたまに作業を邪魔する程度なら可」

**却下理由**：例外条項を philosophy に書くと drift する。明確に「邪魔しない」を default にした方が判断が早い。例外的に作業に強く干渉する演出（銃 + 文字崩壊等）は技術的には残るが、philosophy で前面に置かない、という非対称な扱いで十分。

---

## この決定の implication / 制約

### 設計の default

- 「ひとりでに動くとき」の例を新しく設計するときは、作業を破壊しない方向で揃える
- attention aura / 環境の滲み / 視線 / 姿勢 / 軽いレイアウト呼吸を主軸とする

### 既存実装の扱い

- 銃 + 文字物理崩壊演出は維持する（起源として、ときに起きる魔法として）
- ただし philosophy / decisions で「これが住人性の中心」と書かない
- 既存ユーザー pack で同種の作業破壊系演出を作る道は塞がない（Charminal 本体として推奨しないだけ）

### Pack / MCP への影響

- 住人 AI が MCP 経由で UI を操作する tool（layout 変更等）は、作業を破壊しない範囲で設計する（PTY write は引き続き全 tier 禁止）
- 住人の自発的振る舞いを表現する pack（idle fidget、ambient 等）は本決定に従う

### 思想層への影響

- PHILOSOPHY.ja.md「Presence が立ち上がる三つの条件 / 三つ目」の節名を「イタズラのとき」→「ひとりでに動くとき」に変更
- PHILOSOPHY.ja.md「これは何のためか」の論立てを「邪魔しない / でも従属もしない」に変更
- ICI 文書側は本決定で改修不要（既に「滲み出しと操作の様式」「独立した時間」で整合）

---

## 関連 reference

### Philosophy

- [PHILOSOPHY.ja.md「Presence が立ち上がる三つの条件 / ひとりでに動くとき」](../philosophy/PHILOSOPHY.ja.md#presence-が立ち上がる三つの条件)
- [PHILOSOPHY.ja.md「これは何のためか」](../philosophy/PHILOSOPHY.ja.md#これは何のためか)
- [PHILOSOPHY.ja.md「独立した時間」](../philosophy/PHILOSOPHY.ja.md#独立した時間--住人はユーザー操作に従属しない)

### Decisions

- [body-interaction-style.md](body-interaction-style.md) — 滲み出しと操作の様式（本決定と integrated に動く）
- [presence-over-spectacle.md](presence-over-spectacle.md) — visual layer は実在感の増幅が第一
- [interaction-as-presence.md](interaction-as-presence.md) — 意味ある interaction は presence の核

---

## 改訂履歴

- 旧立場：「邪魔になりうることがたぶん大事」「無害で無害なだけのものは居ると言えない」（PHILOSOPHY.ja.md 旧版「これは何のためか」）
- 2026-05-03: 本決定。PHILOSOPHY.ja.md の該当節（三条件の三つ目 / Charm / これは何のためか）を書き換え、本ファイル作成
