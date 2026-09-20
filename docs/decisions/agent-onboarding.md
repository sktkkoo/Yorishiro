# 初回 health check とエージェント導入

**Status**: active
**Last updated**: 2026-09-20

## TL;DR

導入済みの CLI があれば自動選択して起動し、利用可能なものがない場合だけ初回 health check で導入を案内する。
Codex / Claude Code は個別の明示操作で導入する。画面の説明は短くし、公式リンク・コマンド・アカウント情報を「詳細」にまとめる。
認証と利用契約は利用者自身と提供元の経路に保ち、Yorishiro が token を仲介しない。

## 何を決めたか

### 検出と起動

登録済み adapter の実行ファイルを検出する。これは導入の確認であり、認証済み・契約済みの判定ではない。

| 状態 | 初回 health check の動作 |
|---|---|
| 設定中の agent が利用可能 | 複数導入済みでも、その agent で自動起動 |
| 設定中の agent が未導入、別の agent が利用可能 | 導入済みの Codex、または最初の利用可能な agent を自動選択して保存・起動 |
| 選択が未保存、導入済みの agent がある | 既定の Codex、または最初の利用可能な agent を自動選択して保存・起動 |
| 利用可能な agent がない | 導入画面を表示し、公式手順を「詳細」にまとめる。検出失敗は未導入と区別して表示 |
| 「あとで設定する」 | agent を起動せず shell で続行 |

別の agent の検出が失敗していても、確実に使える agent があれば起動を止めない。明示的な shell / custom command profile は検出による変更を行わない。外部で CLI を導入した後は、Yorishiroのウィンドウへ戻った時点で自動検出する。UI の再確認ボタンは設けず、window focus / document visible で `refresh` を呼ぶ。導入中やほかの処理中は重複実行しない。

正常な初回 health report は表示せずに進む。ユーザーデータや pack など、ほかの実際の問題がある場合は従来の案内を残し、詳しい結果は設定から確認できる。

「あとで設定する」では tutorial の完了を記録せず、Main が shell の間は Quick Chat・音声・会話履歴操作を停止する。別の shell tab を表示しているだけなら Main Agent の機能は継続する。

### 個別のインストール

- タイトルは「エージェントのインストール」/ `Agent installation`。導入文は「Yorishiroの利用には Codex か Claude Code のどちらかが必要です。」とし、各カードに「公式からインストール」/ `Install official CLI` を設ける。公式 installer の説明段落は常時表示しない。
- 公式ガイド・規約リンク、アカウントの説明、手動導入は初期状態で閉じた「詳細」に置く。手動導入の見出しは「インストールコマンド」/ `Install command` とし、「コピー」/ `Copy` はコマンドの右側に置く。
- 導入は各ボタンの明示操作からのみ開始する。表示・自動検出・agent 選択では導入しない。もう片方の導入中も個別に開始できるが、同じ agent の重複実行は防ぐ。
- 進捗・詳細ログ・失敗・再試行を表示する。導入がすべて終わってから、利用する agent の選択または shell での続行を受け付ける。導入完了だけでは agent を起動しない。
- 実装上の installer 対象は macOS / Linux。非対応環境では公式リンクを提示する。本体のサポートプラットフォームを拡張する決定ではない。

## なぜそう決めたか

CLI を事前に導入済みという前提だけでは、初回に agent が起動しない理由と次の操作が分からない。既存の health check の位置で不足を示し、その場で解決できるようにする。すでに使える agent がある場合は確認画面を挟まず、すぐに作業を始められるようにする。

設定中の agent が使える場合はそれを優先する。使えない場合は利用可能なものへ切り替え、不要な導入や選択で起動を止めない。新規の導入は個別ボタンによる明示操作を維持し、長い説明は必要なときに「詳細」で読める形にする。

## 認証・配布の境界

Yorishiro 本体へ CLI を再梱包せず、選ばれた提供元の公式 installer を取得して一般ユーザー権限で実行する。ログインが必要なら、起動したオリジナルの CLI の公式手順を利用者自身が進める。この導入機能はアカウント作成、サブスクリプション購入、認証情報の収集・token の流用や代理認証を行わない。

提供元の利用規約・認証方式・利用料金は各利用者に適用される。「公式からインストール」を提供元の全規約への包括的な同意として扱わない。また、公式 installer の存在や他製品の導入事例を、Yorishiro のすべての利用形態が規約上許可されているという保証にはしない。将来、CLI の再配布や認証方式を変更する場合は別途確認する。

Claude Code の第三者製品への提供には、製品提供者による Anthropic Commercial Terms への同意、オリジナル CLI の利用、認証手段を制限しないこと、利用者自身の契約・認証情報と提供元への直接課金などの条件がある。公開する提供者は[第三者製品への提供条件](https://code.claude.com/docs/en/legal-and-compliance#can-customers-offer-claude-code-in-their-products)を満たす必要があり、利用者のインストール操作が提供者側の同意を代替するわけではない。

## 実装の責任分離

- `src/runtime/agent-setup.ts`: adapter 一覧、実行ファイル検出、起動先の決定、公式案内。
- `src/runtime/agent-setup-controller.ts`: bootstrap の待機、選択保存、独立した導入状態、ウィンドウ復帰時の再検出、skip。
- `src/components/AgentSetupDialog.tsx`: 初回 health check の操作 UI。mount 時の副作用で installer を開始しない。
- `src/runtime/agent-install.ts`: installer command と main window 専用進捗 event の bridge。
- `src-tauri/src/agent_setup.rs`: `claude` / `codex` の allowlist、固定 HTTPS URL、download 成功確認後の実行、出力上限・timeout・process group cleanup。任意 URL / shell command / 認証情報は引数にしない。

## 検討した代替案

- **公式ページだけを開く**: 手動導入の選択肢として残すが、初回体験ではアプリ内導入も提供する。
- **不足する CLI を起動時に自動導入する**: 導入先と提供元を利用者が選ぶ機会を失うため採用しない。
- **複数導入済みなら必ず選択画面を出す／保存済み agent が未導入なら起動を止める**: 利用可能な agent があればすぐ始めるという方針に改訂し、採用しない。
- **正常な health report や長いアカウント説明を初回に常時表示する**: 正常時は進行を妨げず、詳細は利用者が開く形にする。
- **CLI 本体や独自の認証フローを同梱する**: この導入支援の範囲に含めない。

## 関連 reference

- [Codex CLI の公式手順](https://developers.openai.com/codex/cli)
- [OpenAI 利用規約](https://openai.com/policies/row-terms-of-use/)
- [Claude Code の公式セットアップ](https://code.claude.com/docs/en/setup)
- [Claude Code の legal and compliance](https://code.claude.com/docs/en/legal-and-compliance)
- [agent-adapter.md](agent-adapter.md)、[codex-terminal-agent.md](codex-terminal-agent.md)
- [初回セットアップの復旧手順](../troubleshooting.ja.md#初回起動と-health-check)

## 改訂履歴

- 2026-09-20（UI改訂）: タイトルを導入操作に揃え、ボタンを「公式からインストール」に変更。常時表示する installer 説明と再確認ボタンを削除し、ウィンドウ復帰時の自動検出へ変更。公式・アカウント・手動導入の情報を「詳細」にまとめ、コマンド右側に「コピー」を配置。
- 2026-09-20（改訂）: 導入済み agent があれば複数・保存済み選択の不足を問わず自動起動する方針へ変更。公式リンク・コマンド・アカウント情報を「詳細」に畳み、正常な初回 health report を非表示にする。初版の「複数なら選択」「保存済みが見つからなければ停止」はこの改訂で置き換える。
- 2026-09-20: 初回 health check に検出・明示導入・選択保存を統合。公式 CLI と利用者自身の認証を維持する境界を記録。
