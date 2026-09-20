# 初回 health check とエージェント導入

**Status**: active
**Last updated**: 2026-09-20

## TL;DR

初回 health check の中で CLI の検出・導入・選択を扱い、準備前の agent 起動を防ぐ。
Codex / Claude Code は個別の明示操作で公式インストーラーを実行し、両方の導入も可能にする。
認証と利用契約は利用者自身と提供元の経路に保ち、Yorishiro が token を仲介しない。

## 何を決めたか

### 検出と起動

登録済み adapter の実行ファイルを検出する。これは導入の確認であり、認証済み・契約済みの判定ではない。

| 状態 | 初回 health check の動作 |
|---|---|
| 選択が未保存、確実に導入済みの agent が1つ | その agent を選び、選択を保存して起動 |
| 選択が未保存、複数が導入済み | 使う agent を選択して保存 |
| 未導入、または検出失敗 | 導入・公式手順・再確認を提示 |
| 保存済みの選択が導入済み | その選択で起動 |
| 保存済みの選択が見つからない | 導入画面へ。別 agent へ自動変更しない |
| 「あとで設定する」 | agent を起動せず shell で続行 |

明示的な shell / custom command profile は検出による変更を行わない。外部で CLI を導入した後は「再確認」で反映できる。

「あとで設定する」では tutorial の完了を記録せず、Main が shell の間は Quick Chat・音声・会話履歴操作を停止する。別の shell tab を表示しているだけなら Main Agent の機能は継続する。

### 個別のインストール

- Codex と Claude Code の各カードに「インストール」、公式セットアップ・規約リンク、コマンドのコピーを設ける。表示・再確認・agent 選択では導入しない。
- 「インストール」は公式 installer をダウンロードして実行する操作だと事前に説明する。もう片方の導入中も個別に開始できるが、同じ agent の重複実行は防ぐ。
- 進捗・詳細ログ・失敗・再試行を表示する。導入がすべて終わってから、利用する agent の選択または shell での続行を受け付ける。導入完了だけでは agent を起動しない。
- 実装上の installer 対象は macOS / Linux。非対応環境では公式リンクを提示する。本体のサポートプラットフォームを拡張する決定ではない。

## なぜそう決めたか

CLI を事前に導入済みという前提だけでは、初回に agent が起動しない理由と次の操作が分からない。既存の health check の位置で不足を示し、その場で解決できるようにする。

agent を導入することと、その agent を使うことは別の選択。個別ボタンにより両方を試せる一方、保存済みの選択や既存 CLI の環境を尊重する。

## 認証・配布の境界

Yorishiro 本体へ CLI を再梱包せず、選ばれた提供元の公式 installer を取得して一般ユーザー権限で実行する。ログインが必要なら、起動したオリジナルの CLI の公式手順を利用者自身が進める。この導入機能はアカウント作成、サブスクリプション購入、認証情報の収集・token の流用や代理認証を行わない。

提供元の利用規約・認証方式・利用料金は各利用者に適用される。「インストール」を提供元の全規約への包括的な同意として扱わない。また、公式 installer の存在や他製品の導入事例を、Yorishiro のすべての利用形態が規約上許可されているという保証にはしない。将来、CLI の再配布や認証方式を変更する場合は別途確認する。

Claude Code の第三者製品への提供には、製品提供者による Anthropic Commercial Terms への同意、オリジナル CLI の利用、認証手段を制限しないこと、利用者自身の契約・認証情報と提供元への直接課金などの条件がある。公開する提供者は[第三者製品への提供条件](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)を満たす必要があり、利用者のインストール操作が提供者側の同意を代替するわけではない。

## 実装の責任分離

- `src/runtime/agent-setup.ts`: adapter 一覧、実行ファイル検出、起動先の決定、公式案内。
- `src/runtime/agent-setup-controller.ts`: bootstrap の待機、選択保存、独立した導入状態、再確認、skip。
- `src/components/AgentSetupDialog.tsx`: 初回 health check の操作 UI。mount 時の副作用で installer を開始しない。
- `src/runtime/agent-install.ts`: installer command と main window 専用進捗 event の bridge。
- `src-tauri/src/agent_setup.rs`: `claude` / `codex` の allowlist、固定 HTTPS URL、download 成功確認後の実行、出力上限・timeout・process group cleanup。任意 URL / shell command / 認証情報は引数にしない。

## 検討した代替案

- **公式ページだけを開く**: 手動導入の選択肢として残すが、初回体験ではアプリ内導入も提供する。
- **不足する CLI を起動時に自動導入する**: 導入先と提供元を利用者が選ぶ機会を失うため採用しない。
- **不足する保存済み agent を別の導入済み agent へ自動変更する**: 利用者の選択・アカウント・作業環境が変わるため採用しない。
- **CLI 本体や独自の認証フローを同梱する**: この導入支援の範囲に含めない。

## 関連 reference

- [Codex CLI の公式手順](https://developers.openai.com/codex/cli)
- [OpenAI 利用規約](https://openai.com/policies/row-terms-of-use/)
- [Claude Code の公式セットアップ](https://code.claude.com/docs/en/setup)
- [Claude Code の legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [agent-adapter.md](agent-adapter.md)、[codex-terminal-agent.md](codex-terminal-agent.md)
- [初回セットアップの復旧手順](../troubleshooting.ja.md#初回起動と-health-check)

## 改訂履歴

- 2026-09-20: 初回 health check に検出・明示導入・選択保存を統合。公式 CLI と利用者自身の認証を維持する境界を記録。
