# Public development language

**Status**: active
**Last updated**: 2026-08-01

## TL;DR

外部 contributor からの Issue / Discussion は英語・日本語のどちらも歓迎する。
一方、maintainer と開発 agent が新しく作る公開 development artifact は、international reader が追えるよう原則英語にする。
既存の日本語 code comment は一括変換せず、関連 code を触る時に英語へ段階的に揃える。

## 何を決めたか

### 外部 contributor からの入力

- Issue と Discussion は英語・日本語のどちらでも受け付ける。
- 日本語であることを理由に reject したり、英訳を投稿者の必須作業にしたりしない。
- maintainer が必要に応じて英語の要約や label を補い、他の reader が追える状態にする。
- `CONTRIBUTING.md` の「English and Japanese are both fine」は維持する。

### Maintainer / 開発 agent が作る公開 artifact

以下は原則として英語で作る。

- GitHub Issue の title / body
- Pull Request の title / body / review response
- commit message
- 新しく追加する code comment と doc comment

ユーザー向け document に英語版と日本語版がある場合、英語版を international reader 向けの正本として更新し、日本語版も対応させる。日本語の Decision record や内部 design note は、その reader と目的に合う限り日本語のままでよい。

### 既存 code comment の移行

- 既存の日本語 comment を機械的に一括変換しない。
- comment の周辺 code を変更し、その comment も更新対象になった時に英語へ直す。
- 意味が不明確な comment は推測で翻訳せず、元の意図を確認するか、そのまま残す。
- 翻訳だけの大きな diff を機能変更へ混ぜない。

これは「新規 comment は英語を default にし、既存 comment は opportunistic に揃えていく」という移行方針であり、既存の日本語を禁止するものではない。

## なぜそう決めたか

Yorishiro は public OSS であり、maintainer が作る Issue、PR、commit、code comment を英語にすると、international contributor が history と設計意図を追いやすくなる。

一方、Issue や Discussion の投稿に英語を必須にすると、報告や提案の心理的・実務的な barrier が上がる。公開情報の accessibility は maintainer 側の運用で高め、contributor の入口は狭めない方が project にとって有益である。

既存 comment の一括翻訳は、大きな noise diff、翻訳による意味の変化、`git blame` の劣化を招く。そのため、今後の変更に合わせた段階移行を選ぶ。

## 検討したが却下した代替案

### すべての Issue / Discussion に英語を必須とする

International reader には一貫するが、contribution barrier が高すぎるため却下した。

### Maintainer artifact も日本語・英語を自由とする

短期的には楽だが、公開 history の reader が entry ごとに変わり、検索・review・再利用が難しくなるため却下した。

### 既存の日本語 comment を一括して英訳する

機能価値のない巨大 diff と semantic drift の risk が大きいため却下した。

## この決定の implication / 制約

- 開発 agent は、新しい Issue、PR、commit message、code comment を英語で作る。
- 外部 contributor の日本語 Issue / Discussion は歓迎し、英語化を強制しない。
- 日本語で受けた報告を別の公開 artifact に整理する時は、maintainer / agent が英語で要約する。
- Existing Japanese comments are migrated gradually when nearby code is meaningfully edited.
- Language-only cleanup should be isolated from functional changes whenever practical.

## 関連 reference

- `CONTRIBUTING.md`
- `CONTRIBUTING.ja.md`
- `docs/decisions/README.md`

## 改訂履歴

- 2026-08-01: 初版。contributor の言語自由と maintainer / agent artifact の英語 default を分離し、既存 comment の段階移行を決定。
