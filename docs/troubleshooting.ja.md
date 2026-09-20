# トラブルシューティング

Yorishiro alpha はローカル完結型です。復旧に必要な情報はほぼすべて
`~/.yorishiro/` にあり、ネットワーク不要で確認できます。

## 初回起動と health check

初回起動時に、terminal agent・ユーザーデータのパス・safe mode・pack の
読み込み結果・startup report を確認します。問題がなければ案内は表示せず、
対処が必要な問題がある場合に表示します。詳しい結果は設定の「Status」から
いつでも確認できます。

agent のセットアップは、この初回 health check の一部として agent 起動前に行います。

- 設定中の agent が使えれば、Claude Code と Codex の両方があってもそのまま起動します。設定中のものが見つからなければ、導入済みの Codex、または最初に見つかった別の agent を選んで保存します。使える agent がない場合だけセットアップを表示します。
- 「エージェントのインストール」画面で「公式からインストール」を押すと、公式インストーラーを取得・実行します。Codex と Claude Code のボタンは独立しており、両方の導入も可能です。それぞれのボタンを押すまで導入は始まりません。
- 完了まで Yorishiro を開いたままにし、完了後に「Codex を使う」または「Claude Code を使う」を選びます。求められた場合は公式のログイン手順でご自身のアカウントにログインしてください。「インストール済み」は「ログイン済み」ではありません。提供元の利用規約と、アカウント・利用に応じた料金が適用されます。
- アカウント・料金の共通説明は画面上部に表示されます。公式ガイド・規約リンクと「インストールコマンド」は「詳細」を開くと確認できます。コマンドの右側の「コピー」から、ご自身で実行することもできます。外部で導入した後はYorishiroのウィンドウへ戻ると、自動でインストール状況を確認します。失敗時は「ログ」を開いて確認し、再試行するか公式の手順を利用してください。
- 「あとで設定する」は agent を起動せず shell で続けます。準備ができたら Agent 設定を変更して再起動してください。既存の shell / custom command profile の起動方法は維持します。

アプリ内のインストール操作は macOS / Linux 環境向けで、それ以外は公式リンクで
案内します。Yorishiro 本体のサポート対象が現状 macOS のみである点は変わりません。
導入にはインターネット接続が必要です。公式手順:
[Codex](https://developers.openai.com/codex/cli)、
[Claude Code](https://code.claude.com/docs/en/setup)。

## 主要なパス

| パス | 用途 |
|---|---|
| `~/.yorishiro/config.json` | persona・scene・terminal agent・無効化 pack などのユーザー設定 |
| `~/.yorishiro/cohabitation.json` | 同棲時間の runtime state。ユーザー設定ではなく rollback snapshot にも含めない |
| `~/.yorishiro/init.js` | ユーザー起動スクリプト。safe mode ではスキップされる |
| `~/.yorishiro/packs/` | ユーザー作成 pack |
| `~/.yorishiro/.yorishiro-snapshots/` | 内部 rollback snapshot store。手動編集しない |
| `~/.yorishiro/last-startup.json` | 直近の user pack 読み込みレポート |
| `~/.yorishiro/journal/` | Journal と memory ファイル |
| `~/.yorishiro/shell/` | 生成されたシェル統合ファイル |
| `~/.yorishiro/runtime-plugin/` | Claude Code / OpenCode 起動時に渡す生成済み Yorishiro command plugin |
| `~/.agents/skills/yori*/` | Codex が直接発見する Yorishiro 管理の `$yori-*` user skills |

## pack が壊れた場合

pack が失敗しても Yorishiro が開ける場合:

1. Settings を開く。
2. Health で失敗した pack の数を確認する。
3. Packs を開く。
4. 失敗した pack を選択し、診断結果を確認する。
5. 修正ボタンを押すと選択中 agent に合った修正プロンプトがターミナルに挿入されるので、Enter で AI に修復を任せる。
6. 手動で直したい場合は、`~/.yorishiro/packs/` 内のファイルを編集して `Cmd+R` / `Ctrl+R` でリロードする。

pack が原因で Yorishiro が開けない場合は safe mode を使ってください。

## Safe mode

Safe mode はユーザー pack と `init.js` をスキップします。ユーザーデータは削除されません。

macOS:

```bash
YORISHIRO_SAFE_MODE=1 open /Applications/Yorishiro.app
```

ソースから:

```bash
YORISHIRO_SAFE_MODE=1 npm run tauri dev
```

壊れた pack を無効化または修正したら、`YORISHIRO_SAFE_MODE` なしで再起動してください。

## クリーンアンインストール

Yorishiro アプリ本体を削除しても、ユーザーデータや生成済み agent 統合 cache は
自動削除されません。通常のアンインストールでは設定や拡張データを残し、再インストール
で再利用できるようにする一般的な desktop app の挙動に合わせています。

Claude/OpenCode の Yorishiro commands は、Yorishiro が選択中 agent を起動するときだけ
注入されます。Codex の `$yori-*` は Codex 標準の user skill discovery location に
生成されるため、生成後は Yorishiro 外で起動した Codex にも表示されます。

pack を消さずに生成済み command integration cache だけ削除する場合:

```bash
rm -rf ~/.yorishiro/runtime-plugin
rm -rf ~/.agents/skills/yori{,-create,-update,-help,-shortcut,-tutorial}
```

pack、config、cohabitation state、journal、memory、rollback snapshot、生成ファイルを含めて
Yorishiro のユーザーデータをすべて削除する場合は `~/.yorishiro` を削除します。これは破壊的操作なので、アプリ本体の
アンインストールとは別に扱ってください。

## クラッシュ復旧画面

React ランタイムがクラッシュした場合、復旧画面が表示されます:

- safe mode コマンド
- user pack ディレクトリ
- startup report のパス
- エラー詳細
- Reload ボタン

クラッシュを報告する際は、復旧画面に表示されたエラー詳細と、該当する場合は
`~/.yorishiro/last-startup.json` の内容を含めてください。

## Issue 報告チェックリスト

ユーザー作成 pack に起因する問題は Issue の対象外です。pack が原因と思われる
場合は、まず修正ボタンか Yorishiro update command で AI 修復を試してください。すべての
ユーザー pack を無効化（safe mode）しても問題が再現する場合のみ Issue を報告して
ください。

以下を含めてください:

- Yorishiro のバージョンまたはコミットハッシュ
- OS と CPU アーキテクチャ
- インストール方法: `.dmg`、ソースチェックアウト、その他
- 選択中の terminal agent: Claude Code、Codex、OpenCode
- safe mode で挙動が変わるかどうか
- 関連する user pack の id（あれば）
- `~/.yorishiro/last-startup.json`（存在する場合）
- クラッシュ復旧画面のエラー詳細（表示された場合）
