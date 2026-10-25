export type AutonomyPanelLanguage = "ja" | "en";

const english: Readonly<Record<string, string>> = {
  "作成・編集": "Create and edit",
  移動: "Move",
  退避: "Move to recovery",
  次の作業を待っています: "Waiting for the next task",
  目的に沿って次の仕事を考えています: "Choosing the next task for your goal",
  復元できる状態を確保して変更しています: "Making changes with recovery available",
  作業プロセスの終了を待っています: "Waiting for work to stop",
  一時停止中: "Paused",
  作業を停止しました: "Work has stopped",
  今回の作業が終わりました: "This task is complete",
  続けるための指示を待っています: "Your input is needed to continue",
  今日の仕事について相談しています: "Today's task needs your decision",
  作業結果の確認を待っています: "A proposed operation needs your decision",
  承認した操作を実行しています: "Carrying out the approved operation",
  以前の処理状況を確認してください: "Review the previous operation's status",
  作業中: "Working",
  完了: "Completed",
  失敗: "Failed",
  中断: "Interrupted",
  元に戻しました: "Restored",
  提案: "Proposed",
  "おまかせ作業の目的と範囲を相談したいです。質問から始めてください。":
    "I'd like to discuss the goal and scope of autonomous work. Start with a question.",
  目的: "Goal",
  フォルダ: "Folder",
  許可する操作: "Allowed file operations",
  確認する間隔: "Work interval",
  実行上限: "Run limit",
  進め方: "When to start",
  任せる仕事の種類: "Type of work",
  PRの公開: "Pull request publication",
  目的達成に必要な操作の自動許可: "Automatic operation permission",
  停止処理中: "Stopping",
  実行中: "Working",
  "自動作業 {state}": "Automatic work {state}",
  "承認待ち {count}件": "{count} awaiting your decision",
  今日の仕事を相談: "Review today's task",
  "・": " · ",
  "音声での相談を開始しています…": "Starting voice consultation…",
  "相談中に設定案が更新されました。今の入力を残しています。変更したい内容をもう一度相談できます。":
    "The draft changed during consultation. Your current input is preserved. You can discuss your changes again.",
  任せるフォルダ: "Choose a folder for autonomous work",
  "、": ", ",
  その日の仕事を先に相談: "Review today's task before starting",
  範囲内で自動的に進める: "Choose and start tasks automatically",
  "{field}の更新を確認": "Review changes to {field}",
  "AIもこの項目を更新しました。入力した内容は保持しています。":
    "AI also changed this field. Your input is preserved.",
  "AIの案:": "AI suggestion:",
  未設定: "Not set",
  AIの案を使う: "Use AI suggestion",
  自分の入力を残す: "Keep my input",
  おまかせ作業: "Autonomous work",
  "おまかせ作業 確認待ち {count}件": "Autonomous work, {count} awaiting your decision",
  "作業の目的・範囲・実行状況を管理": "Set a goal. Review decisions and results.",
  おまかせ作業を閉じる: "Close autonomous work",
  "閉じる（Esc）": "Close (Esc)",
  "設定を読み込んでいます…": "Loading your settings…",
  作業状況: "Work status",
  "今、任せていること": "Your saved goal",
  必要な操作は個別確認なしで実行: "Necessary operations can run without individual approval",
  作業の成果を保存しています: "Saving the work results",
  目的に沿った作業と検証を進めています: "Working on your goal and checking the results",
  承認した操作の実行を準備しています: "Preparing the approved operation",
  "次回:": "Next:",
  自動作業: "Automatic work",
  一時停止: "Pause",
  今すぐ進める: "Run now",
  承認待ち: "Needs your decision",
  "{count}件": "{count}",
  今日の仕事の相談: "Today's task proposal",
  "今日、進めたい仕事": "A task for today",
  "この仕事を任せると、継続して許可した範囲内で進めます。":
    "This task will use your saved scope and permissions.",
  "今日の仕事を任せました。": "Today's task is ready to start.",
  この仕事を任せる: "Start this task",
  "今回は見送りました。": "Skipped this task.",
  今回は見送る: "Skip for now",
  設定: "Task settings",
  "この範囲で作業を開始します。範囲はいつでも変更できます。":
    "Work will begin within this scope. You can change it at any time.",
  任せる範囲: "What to work on",
  任せる目的: "Goal",
  対象フォルダ: "Folder",
  会話で決めたフォルダ: "Folder for this work",
  フォルダを選ぶ: "Choose folder",
  実行時の確認: "Operation approval",
  目的達成に必要な操作を自動で許可する: "Automatically allow operations needed for this goal",
  実行前の確認を省略します: "Operations can run without asking you first",
  "目的の達成に必要な外部送信・公開も、操作ごとの確認なしで実行します。必要に応じてサービスの保存済みログインを使います。":
    "This includes sending information and publishing externally without confirmation for each operation. Saved service logins may be used when needed.",
  "送信や公開など、取り消せない変更があります。対象・内容・実行結果は履歴に残ります。":
    "Some changes, including sending and publishing, cannot be undone. Targets, contents, and results are recorded in history.",
  "オフにすると、必要な操作をその都度確認します。":
    "Turn this off to review each necessary operation before it runs.",
  "外部送信・公開などの操作は、対象と内容をその都度確認します。":
    "You review the target and contents before operations such as sending or publishing.",
  "外部送信などツールを使う操作には、作成・編集／移動／退避の許可が必要です。":
    "Tool operations such as external sending require Create and edit, Move, and Move to recovery permissions in Advanced settings.",
  "編集内容をAIに反映できませんでした。": "Your edits could not be shared with AI.",
  "同じ項目の更新を確認してください。": "Review the conflicting field updates.",
  "編集内容をAIに反映しています…": "Sharing your edits with AI…",
  反映を再試行: "Retry sharing edits",
  AIからの提案を見る: "Read the AI proposal",
  詳細設定: "Advanced settings",
  自動で進めてよい操作: "Allowed file operations",
  "コード変更を任せる場合は3項目すべてを許可してください。許可していない操作は行いません。":
    "Code work requires all three file permissions. Only the operations you allow are performed.",
  "確認する間隔（分）": "Work interval (minutes)",
  "24時間の実行上限（回）": "Run limit per 24 hours",
  "24時間の実行上限は1以上の整数で設定できます。":
    "Choose a positive whole number of runs per 24 hours.",
  作業の範囲と実行条件: "How the work runs",
  "目的に沿って必要な仕事を選び、実行と検証まで進めます。 Gitリポジトリではコミット済みの内容を別の作業場所に複製し、文書やコードの改善・テストを行います。未コミットの変更は含みません。 通常のフォルダではテキスト文書を整理・編集します。":
    "AI chooses tasks for your goal and makes and checks changes. Git repositories use a separate copy of committed files; uncommitted changes are excluded. Ordinary folders support text document work.",
  "変更は復元できる形で保存し、作業結果と検証内容を履歴に残します。 必要な依存関係や認証がなければ停止して知らせます。":
    "Local document changes are saved with recovery information. Results and checks appear in history. Work stops if dependencies or authentication are missing.",
  "Gitリポジトリでの作業にはCodex、通常のフォルダでの文書作業にはClaude Codeへのログインが必要です。 Yorishiroを開いている間に動作し、AIの利用枠を消費します。 目的達成に必要な操作の自動許可には、Claude CodeとCodexへのログインが必要です。必要な外部送信・公開も自動で進めます。 許可しない場合は、具体的な対象と内容を個別に確認します。":
    "Repository work requires a Codex login; document work uses Claude Code. Autonomous work runs while Yorishiro is open and uses your AI allowance. Automatic operation permission requires both Claude Code and Codex logins. When enabled, necessary external sending and publishing can run automatically. Otherwise, you review each target and operation.",
  "詳細設定で許可する操作を選んでください。":
    "Choose allowed file operations in Advanced settings.",
  "「この範囲で任せる」を押すと、設定を保存して自動作業を有効にします。":
    "Start with this scope saves these settings and enables autonomous work.",
  "保存しています…": "Saving…",
  この範囲で任せる: "Start with this scope",
  AIに相談: "Discuss with AI",
  任せる範囲の相談: "Discuss the work scope",
  "会話で設定を更新できます。直接編集した内容も次の相談に反映されます。":
    "Talk through your settings. Your manual edits are included in the next conversation.",
  音声で相談する: "Talk by voice",
  文字で相談する: "Write a message",
  相談の履歴: "Consultation history",
  あなた: "You",
  相談したいこと: "Your message",
  "例えば、メモを読みやすく整理して、次に取り組むことをまとめてほしい":
    "For example, organize my notes and help me choose what to work on next",
  "相談しています…": "Discussing…",
  AIと相談する: "Send to AI",
  承認履歴: "Operation history",
  作業履歴: "Task history",
  "作業を進めています…": "Work is in progress…",
  "この作業の確認事項は見送りました。": "The proposed operation for this task was skipped.",
  結果についてAIに相談: "Discuss this result",
  詳細: "Details",
  "確認用の成果物:": "Review artifact:",
  "ブランチ:": "Branch:",
  "検証:": "Checks:",
  "変更を元に戻しました。": "Changes restored.",
  この作業を元に戻す: "Undo this task",
  最新3件を表示: "Show latest 3",
  "すべて表示（{count}件）": "Show all ({count})",
  "おまかせ作業の結果について相談したいです。必要な確認事項と次にできる操作を教えてください。公開や実行の承認ではありません。\n作業ID: {id}\n結果: {summary}\n理由: {reason}":
    "I'd like to discuss this autonomous work result. Explain what needs review and what can be done next. This is not approval to publish or execute.\nTask ID: {id}\nResult: {summary}\nReason: {reason}",
};

/** Source-language keys keep the Japanese interface and English copy aligned. */
export function autonomyPanelText(language: AutonomyPanelLanguage) {
  return (source: string, values: Readonly<Record<string, string | number>> = {}): string => {
    const text = language === "en" ? (english[source] ?? source) : source;
    return text.replace(/\{(\w+)\}/g, (token, key: string) => String(values[key] ?? token));
  };
}

export const autonomyPanelLocale = (language: AutonomyPanelLanguage): string =>
  language === "en" ? "en-US" : "ja-JP";
