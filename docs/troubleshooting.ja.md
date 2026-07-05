# トラブルシューティング

Yorishiro alpha はローカル完結型です。復旧に必要な情報はほぼすべて
`~/.yorishiro/` にあり、ネットワーク不要で確認できます。

## 初回起動と health check

初回起動時に、選択中の terminal agent・ユーザーデータのパス・safe mode の
状態・pack の読み込み結果・startup report のパスを表示します。
同じ情報は Settings → Health からいつでも確認できます。

選択中の agent が見つからない場合は、Claude Code か Codex をインストールするか、
Agent 設定を変更して Yorishiro を再起動してください。

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
| `~/.codex/plugins/cache/yorishiro-local/` | `$yori-*` skills 用の Yorishiro local Codex plugin cache |

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
YORISHIRO_SAFE_MODE=1 open /Applications/yorishiro.app
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

Yorishiro commands は、Yorishiro が選択中 agent を起動するときだけ注入されます。
Yorishiro が起動していない場合、Claude/OpenCode の command plugin は渡されず、
Codex plugin cache も Yorishiro が起動時に渡す `-c` 有効化 flag が無いため有効化されません。

pack を消さずに生成済み command integration cache だけ削除する場合:

```bash
rm -rf ~/.yorishiro/runtime-plugin
rm -rf ~/.codex/plugins/cache/yorishiro-local
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
