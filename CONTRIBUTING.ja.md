# Contributing to Yorishiro

> [English CONTRIBUTING](CONTRIBUTING.md)

## コントリビュートの方針

**Issue と Discussion は大歓迎です。いまのところ、これが一番ありがたい貢献の形です。** 一行でも構いませんし、テンプレートをきれいに埋める必要もありません。日本語でも英語でも構いません。

- **バグ報告** — [Issue テンプレート](.github/ISSUE_TEMPLATE/) を使ってください
- **機能要望・提案** — まとまっていなくて構いません。Issue で自由にどうぞ
- **質問・感想・作った pack の共有** — [Discussions](https://github.com/sktkkoo/Yorishiro/discussions) を使ってください
- **セキュリティ報告** — [SECURITY.md](SECURITY.md) を参照

Pull request だけは例外で、まだ受け付けていません。pack API とセキュリティ境界が安定したのち、改めて検討します。

### Pack による拡張

「この機能がほしい」「見た目を変えたい」の多くは、core を変更しなくても **Pack** で実現できます。Pack の作り方は [`src/sdk/README.md`](src/sdk/README.md) を参照してください。`/yori:create` コマンドで会話しながら作成できます。

## ライセンス

Yorishiro は [MIT License](LICENSE) の下で公開されています。

将来 Pull Request の受け入れを開始する場合、提出されたコードは同じ MIT License の下で提供されたものとして扱います。

## 開発者向け情報

ローカルでビルド・開発する場合は [DEVELOPMENT.md](DEVELOPMENT.md) を参照してください。
