# Contributing to Yorishiro

> [English CONTRIBUTING](CONTRIBUTING.md)

## コントリビュートの方針

**Issue と Discussion は大歓迎です。いまのところ、これが一番ありがたい貢献の形です。** 一行でも構いませんし、テンプレートをきれいに埋める必要もありません。日本語でも英語でも構いません。

- **バグ報告** — [Issue テンプレート](.github/ISSUE_TEMPLATE/) を使ってください
- **機能要望・提案** — まとまっていなくて構いません。Issue で自由にどうぞ
- **質問・感想・作った pack の共有** — [Discussions](https://github.com/sktkkoo/Yorishiro/discussions) を使ってください
- **セキュリティ報告** — [SECURITY.md](SECURITY.md) を参照

小さく独立したバグ修正、テスト、ドキュメント、プラットフォーム互換性の修正は、直接 Pull Request を送れます。関連 Issue がある場合はリンクしてください。小さな変更すべてに Issue を作る必要はありません。

Pack API、セキュリティ、権限、IPC、provenance、サンドボックス、アーキテクチャに関わる大きな変更は、実装前に Issue で設計を相談してください。[PR テンプレート](.github/pull_request_template.md)に変更範囲と検証結果を記載し、[レビューの担当範囲と Pack チェックリスト](docs/contributor-review.md)も確認してください。

ソースコードの PR 受付は、コミュニティ Pack のインストール機能の提供や安全性の認定を意味しません。ローカル Pack は引き続き信頼済みコードとして実行されます。[SECURITY.md](SECURITY.md)を参照してください。

### 1.0 より前の互換性

サポートする制作 API は [`src/sdk/README.md`](src/sdk/README.md)に明記されています。Pack API は 1.0 相当の互換性保証で固定されていません。サポート対象の動作を変更する場合は、互換性への影響と必要な移行方法を記載し、適切な回帰テストを追加してください。ドキュメント化されていない内部 API は、サポート対象の拡張契約ではありません。

### Pack による拡張

「この機能がほしい」「見た目を変えたい」の多くは、core を変更しなくても **Pack** で実現できます。Pack の作り方は [`src/sdk/README.md`](src/sdk/README.md) を参照してください。`/yori:create` コマンドで会話しながら作成できます。

## ライセンス

Yorishiro は [MIT License](LICENSE) の下で公開されています。

Pull Request で提出されたコードは、同じ MIT License の下で提供されたものとして扱います。

## 開発者向け情報

ローカルでビルド・開発する場合は [DEVELOPMENT.md](DEVELOPMENT.md) を参照してください。
