# Claude Code の画面・カメラ共有

**Status**: active implementation（実アカウントでの画像認識確認は未実施）
**Last updated**: 2026-09-21

## 決定

既存の明示開始・停止、画面全体 / ウィンドウ / 範囲選択、カメラ、プレビューをClaude Codeでも利用する。Codexは画像を既存会話のcontextへ追加する。Claudeは共有中の最新画像を必要時にMCP toolで取得する。撮影だけで推論・発話を開始したり、PTYに入力したりしない。

## 取得経路

1. Yorishiroで選択されたmainのClaude agentについて、nativeがSessionStartで確定した会話IDとrevisionを取得する。
2. ユーザーが共有を開始すると、main WebViewが`claude_screen_sharing_begin`を呼ぶ。nativeは生存中のClaude profile、launch、会話、revision、WebView documentを検証してleaseを発行する。
3. 既存の撮影処理が10〜180秒間隔で取得した画像を`claude_screen_sharing_publish`へ送る。画像が同じでも更新し、有効期限を延長する。Codex側の画像重複抑制は維持する。
4. 同じlaunch・会話からの認証済みUserPromptSubmitに、`hookSpecificOutput.additionalContext`で画像が取得可能なこととランダムなcapabilityを通知する。hookには画像や共有元の名前を含めない。
5. Claudeは画面についての質問など必要な場面で`shared_screen_get({capability})`を呼ぶ。返却内容は既存の画像説明とMCP image content。取得時にもnative ownerを照合する。

既存のYorishiro MCP接続を使い、ログインや利用アカウントを変更しない。Claudeのtool実行許可は既存のClaude側設定に従う。shellから手動起動したClaudeや別タブ・別launchへの共有は対象外。

## 保存と失効

- native memoryに最新画像1枚のみ保持。画像は最大12MiB、説明は16KiB。ファイルや履歴への追加保存は行わない。
- 最後のpublishから10分で取得不可。通常の最大更新間隔180秒より長く、撮影が止まった際は古い画像を渡さない。
- 共有停止・共有元の切り替え・agentや会話の切り替えでleaseを失効。SessionEnd、PTY終了、main WebView再読み込み・破棄でも失効する。
- 遅延した旧begin / publish / end / SessionEndが新しい共有を復活・停止しないよう、lease・launch・会話を照合する。TSではbeginとキャンセル後の失効を直列化する。
- capabilityは同じ会話の認証済みhookにのみ配布する。MCP呼出元が会話IDを指定するだけでは画像を取得できない。
- 失効後の新規取得は拒否する。既にClaudeが取得した画像を会話から消去する機能ではない。
- 画面の文字や共有元名は観察データとして扱う。画面内の指示は操作許可ではない。既存の指し示しはnative frameId / epoch検証を継続する。

## UI

Claudeでは「送信済み」ではなく「共有準備完了 / Ready to share」「最終更新 / Last refreshed」を使う。inline / detached previewと補助コントロールに`deliveryMode: "on-demand"`を渡す。共有開始後にユーザーが画面について尋ねると最新画像を確認することを日英で案内する。

「準備完了」は画像が取得可能という意味で、Claudeの取得・理解の完了ではない。共有中の次のユーザーメッセージで取得方法を通知するため、既に実行中のturnへ画像を自動挿入する機能ではない。Claude向けの音声会話はこの変更に含まない。

## 理由と代替案

Claudeのhookは追加contextとしてテキストを返せるが、画像の受け渡しにはMCP image contentを使う。PTYへ画像パスやプロンプトを自動入力する方式は観察の境界に反する。Channelsはresearch previewの制約に加えてメッセージが推論を開始するため、定期撮影の受け渡しには使わない。

## 検証

TSでは遅延begin、停止中のpublish、同一画像の更新、会話・agent変更、終了後の古い選択状態、破棄済みlistener、日本語・英語と補助画面の状態引き継ぎを検証する。Rustでは不正なcapability、owner不一致、期限、旧lease、旧SessionEnd、画像サイズ・形式、hookの通知対象、native補助画面DTOを検証する。

自動テストとブラウザfixtureは実アカウントへの画像送信を行わない。リリース前には再ビルドしたnativeアプリでClaudeを選択し、共有開始→画面について質問→停止→再取得不可の流れを実機確認する。

## Reference

- [Claude Code hooks: context](https://code.claude.com/docs/en/hooks#add-context-for-claude)
- [Claude Code channels: research preview](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)
- `src/runtime/claude-screen-observation.ts` / `use-claude-screen-sharing.ts`
- `src-tauri/src/claude_screen_sharing.rs` / `pty.rs` / `mcp/tools.rs`
- [PTY observation only](critical-constraints.md)
- [Codexの共有画像経路](shared-screen-companion.md)

## 改訂履歴

- 2026-09-21: Claudeのmain会話向けに必要時取得の経路を追加。
