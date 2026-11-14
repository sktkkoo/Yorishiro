# ジャーナルの改善：会話と記憶の保持・context の上限

**Status**: active
**Last updated**: 2026-11-14

## 決定

利用者向けの名称は引き続き **ジャーナル** とする。今回の会話・記憶の保持と context の見直しは、同じジャーナルの改善として扱う。画面で覚えている内容を見返す一覧は、日本語で「メモリー」、英語で「Memories」と表示する。

通常の会話は、モデルが全文を確認して不要と判断した発言だけを整理する。最近 30 日かつ最新 200 件を保持の目安とし、重要な根拠・明示的に覚えるよう依頼された発言・未レビューの発言は上限の例外として残す。保存内容とモデルへ渡す context を分け、音声は最大 8 KiB の要約表示、新規の実行は必須の根拠と最近の記録を選ぶ予算付き context にする。

これは保存全体を 200 件や一定容量へ収める仕様ではない。未完了の依頼を件数・経過日数・沈黙だけで完了扱いにしない。

## 会話を整理できる条件

既存のモデル返答に `retiredMessageIds` を追加し、本文を実際に読んだ、不要な雑談または完了済みのやり取りを ID で指定する。整理 ID の出力だけが膨らまないよう、1 回のモデル report につき最大 32 件とし、prompt・schema・native の検証で制限する。新しい依頼、未回答の提案、継続中の制約、操作権限の境界、必要な根拠が残る発言は指定させない。`workStatus=idle` や `nextStep=null` だけでは削除を認めない。省略された本文は、取得可能な経路で全文を確認してから判断する。取得 tool のない text 経路では、その本文を必要とする判断を延期する。

native 側は、次の条件を満たす発言だけを保存時に取り除く。

1. `retiredMessageIds` に明示されている。
2. 元の配列順で最新 200 件より前、または保存時刻から 30 日を超えている。
3. 保護対象の出典にも、最新のユーザー発言とそれ以降の返答にも含まれない。

30 日ちょうどは期限内とする。将来の timestamp は経過日数だけでは削除しない。旧データに整理済み ID がない場合、古いという理由だけで移行時に一括削除しない。

保護対象は次のとおり。

- 記憶の現在値と改訂履歴が持つ `sourceIds`。
- 草案と振り返りが持つ `sourceIds`。却下済みの草案も再提案を防ぐため出典を残す。
- 最新のユーザー発言と、それ以降の assistant の提案・報告・分類待ちの返答。
- ユーザーが明示的に覚えるよう依頼した発言の原文。受信・保存時に保護し、通常の整理では削除しない。
- モデルが不要と判断していない発言。

明示的な「覚えて」の保護は、原文を失わないための host 側の処理であり、モデル呼び出しの完了を待たない。新しい user 発言を受け取った時点で、日本語・英語の対象表現を検出し、`Snapshot.explicitMemories` に `{requestMessageId, sourceIds}` を記録する。依頼の原文に加え、直前の user 発言とその間の assistant の返答を出典として保護し、「それを覚えて」の参照候補を失わないようにする。legacy の発言、草案 UI が生成した `draft-action`、assistant 自身の指示は新たな記憶依頼として扱わない。

これは限定した表現の検出であり、あらゆる言語・否定・引用・曖昧な指示対象を意味的に理解する保証ではない。参照候補をそのまま事実や好みとして確定せず、利用時には原文を読む。原文の保護と、好み・約束・訂正を意味のある記憶として整理する処理は別であり、後者は既存のモデル返答を検証して反映する。記憶は新しい操作の許可にはならない。

処理中・待機中・復旧待ちの仕事がある場合は、会話の削減自体を延期する。`running` / `queued`、`pending_execution`、訂正待ち、trigger、次の作業、error / blocked / recovery / stagnation の状態を確認する。受理済み処理は `message_count` を発言配列の境界として使っているため、途中で配列を縮めない。保存に失敗した場合は、整理前を含む直前の確定状態へ戻す。

## メモリーを忘れる操作

メモリー一覧の「忘れる」（英語では `Forget`）は、確認後に選択した保存済みメモリーを取り除く操作である。対象の understanding のタイトル・値・改訂履歴を削除し、その ID に直接関連する reflection も削除する。reflection が複数のメモリーをまとめている場合は、削除対象の内容だけを推測して切り出さず、その reflection 全体を取り除く。他のメモリー、元の会話、草案、明示的な記憶依頼の参照は保持する。

再登録を防ぐため、`Snapshot.forgottenUnderstandings` に `{understandingId, sourceIds, forgottenAt}` を保存する。内容は削除したメモリーの ID、現行値と改訂履歴の出典、操作時刻だけである。削除したタイトルや値を tombstone にコピーしない。同じメモリー ID の再登録と、削除対象の source ID を使った新しいメモリー ID の登録を抑止する。一方、すでに存在する別のメモリーは、同じ出典を参照していても維持し、その更新を一律に止めない。これは ID・出典に基づく再登録防止であり、同じ意味の内容をあらゆる経路から検出する仕組みではない。後でユーザーが改めて伝えた情報は、新しい実際の発言を根拠に、新しい ID のメモリーとして登録しうる。

この保存では通常の会話 retention を同時に実行せず、「忘れる」を押した結果として元の会話を削除しない。ただし、tombstone の source ID は原文を永久保存する pin ではない。後の通常保存では、元の会話が整理済みで他の保護対象に含まれなければ、30 日・200 件の保持方針に従って削減されうる。既存の明示的な記憶依頼による pin は、別の保護対象として残る。

受理済み prompt / payload と実行 archive は書き換えない。処理中の返答から削除したメモリーが復活しないよう、返答適用時にも現在の tombstone を確認する。新しい context の明示的な記憶表示では、削除した出典に関わる pin の再提示を抑止するが、元会話や他のメモリー・草案に同じ情報が残ることはある。prompt に載せる削除記録のヒントは最大 8 件で、既存の byte 予算に入るものだけを選ぶ。大きなヒントや残りの件数を省略しても、保存済みの全 tombstone による host 側の登録抑止は継続する。

「忘れる」自体はモデルの推論・発話 turn や新しい自律処理を開始しない。表示と新しい context は既存の更新経路で更新し、接続中の Live には context 更新の通信が発生しうる。既存の自律処理や定期判断を停止する操作でもない。接続中の AI へすでに送った情報、Claude / Codex / Pi の履歴、旧 journal、保存済みの実行証拠は消去しない。特に Live の context 更新は追記であり、過去に送信した内容の消去ではない。「完全に忘れる」「二度と話題にしない」という保証にはしない。確認画面では、保存済みメモリーの削除と元会話・送信済み履歴の保持を区別して伝える。

## 音声へ渡す context

[`voice-continuity.ts`](../../src/core/global-prompt/voice-continuity.ts) は、保持済みの snapshot から次の候補を選ぶ。

| 内容 | 最大件数 |
| --- | ---: |
| 最近の会話（legacy を除く） | 6 |
| 現在の記憶 | 8 |
| 草案 | 3 |

header と JSON escaping を含む全体を **8,192 UTF-8 bytes** 以下にする。これは token 数の制限ではなく、バイト数の制限である。最大件数まで必ず入るとは限らない。

最新のユーザー発言、直近の訂正、草案、次の作業を優先し、残りの予算へ他の候補を追加する。長い本文の表示は先頭・末尾を残し、`partial` と元のバイト数を付ける。大きな草案は本文を省略し、取得してから使うよう指定する。source ID・省略件数を残し、未表示の依頼を完了扱いにしたり、要約から草案全文を捏造したりしない。

省略件数は、その snapshot に保持されている記録との差分であり、生涯の全履歴件数ではない。必要な保持済み本文は backing agent の `continuity_context` 等から取得する。この表示の短縮は、保存済み原文や受理済み実行 payload を書き換えない。新規実行の context には、以下の別の予算を適用する。

## journal と global prompt 全体との境界

既存の journal は、persona ごとの `daily/*.md` と `memories.md` を持つ独立した記録である。continuity は保存 state がまだないときだけ、その内容を未検証の legacy 記録として取り込む。以後の journal と continuity は継続的に同期する関係ではなく、この保持処理は journal を削除・整理しない。

音声と通常の terminal bootstrap に使う短い continuity fragment は、同じ projection を共有する。ただし **8 KiB は continuity fragment だけの上限であり、global prompt 全体の上限ではない**。独立した journal fragment は現在、`memories.md` の最新 5 件と古い記憶からランダムに 2 件、直近 1 日の journal を選ぶ。persona 指示や他の fragment も別に加わるため、今回の制限だけで総入力 token 数や journal 本文の容量を保証しない。

### 従来の日記保存実装の今後の扱い

今回の保持処理を先に完成させ、従来の日記と `memories.md` を扱う実装は将来廃止する方針とする。ジャーナルという機能名は継続する。必要な記録の移行と、従来の読み書き・prompt 追加経路の置き換えを確認するまで削除しない。この変更に移行・削除コードは含めない。

内部の `continuity` 名、保存パス、API は維持する。従来の保存データから何を引き継ぐか、原文・出典をどう保つか、移行後にどの経路を停止するかは、実装の廃止前に別途設計する。

## 新しい実行へ渡す context

Pi / Codex / text の新しい実行では、同じ選択規則で context を組み立てる。未レビューの user 発言、保護された根拠、明示的な記憶依頼とその原文、未回答の提案、処理対象の訂正を優先する。最近の会話・記憶・草案・振り返りは、出典を含む完全な記録が予算内に入る場合に追加する。実行用の原文を途中で切って別の意味にしない。

prompt 全体は **96 KiB の UTF-8 bytes** 以下とし、Pi / Codex の実行 projection は schema と JSON escaping を含む submit 表現も **256 KiB** 以下で確認する。text は実際に送る prompt 全体で確認する。必須の情報だけで予算を超える、または必須の出典が欠ける場合は、情報を黙って捨てずに実行を止める。音声表示の 8 KiB と混同しない。

| 経路 | 省略された記録を確認する方法 |
| --- | --- |
| Pi | request 作成時点の保持済み記録を immutable archive に保存する。`read_continuity_context` で request ID・collection・index・offset を指定して読み、続きがある場合は全文を確認する |
| Codex | backing agent の `continuity_context` で現在の保持済み会話・記憶・草案を読む。request 作成時点の archive ではなく、内容が変わりうる。過去の receipt は同 tool の `executionReceiptIndex`・`characterOffset`・`maxCharacters` で分割取得し、参照先 Main Agent turn と現在の workspace も確認する |
| text | on-demand の取得 tool はない。省略された詳細を必要とする結論を延期する |

Pi / Codex には保持件数・hash・上限付きの直近 receipt 概要も渡す。Codex の `continuity_context` は通常の snapshot 取得に加え、指定した現在の receipt の JSON 原文を文字単位で分割取得できる。`maxCharacters` は既定 4,096、範囲 1〜16,384 とし、`nextCharacterOffset` がなくなるまで読み、各 chunk の `personaId`・`requestId`・`receiptSha256` が同じことを確認する。返る revision と件数も現在の状態であり、index は immutable archive の位置ではない。概要や省略件数は、完了・却下・新しい操作権限の証拠ではない。途中まで副作用が生じた処理を、概要だけで再送・再実行しない。

既存の受理済み prompt / payload と archive は変更しない。この選択は保存記録の削除ではなく、新しい依頼に渡す情報の選択である。

## 更新のタイミングと使用量

ディスクへの保存、記憶の意味的な更新、モデル呼び出しは同じ出来事ではない。

| きっかけ | 既存の処理 |
| --- | --- |
| 音声のユーザー transcript が確定 | 原文を保存する。Codex 経路では、その観測だけを理由に別の判断を開始しない。Pi / text 経路では `external` 判断をキューへ入れるが、Auto が Off の自動判断は実行しない |
| メッセージ送信・訂正・草案の続行／却下・再試行 | 明示操作として判断を開始する |
| workspace を開く・有効な自律処理を復元する | Auto の設定・既存の仕事・復旧状態に従い、初回の `return` または再開をキューへ入れる |
| Auto が On の待機中 | native の基本間隔は 5 分。実行中・キュー済み・blocked・再試行待ちなどでは実行しない |
| 有用な `nextStep` がある | 既存処理の完了後、5 分を待たず次の処理を続ける |
| 正常なモデル返答を検証・適用 | 根拠のある記憶・訂正・草案・振り返りと `retiredMessageIds` を反映する |

整理は既存の返答へ付随させる。整理専用のモデル呼び出しや timer は追加せず、既存の呼び出し頻度を新たに間引く処理も加えない。説明文と返答 field の分の入力・出力 token は増えうるが、保存時の保護判定や target の重複排除はローカル処理である。

実行 context の 96 KiB prompt / 256 KiB submit 制限も token 数ではない。一つの continuity 処理にはツール利用や retry による複数のモデル応答が含まれうる。Pi の durable SQLite にはモデルごとの `usage` が残る一方、native の `WorkRun` は token usage を持たない。現状は「記憶整理だけ」の使用量・費用を分離して計測していない。SDK の価格表による推計を、請求額や OAuth 契約の課金額と同一視しない。

## disk v2 / v3：対象情報の重複排除と削除状態の保護

削除状態を持たない保存は disk v2、tombstone を持つ保存は disk v3 とする。v3 を扱わない旧 binary が削除状態を捨てて記憶を復活させないよう、version の不一致で読み込みを拒否させる。読み込み側は v1 / v2 / v3 を扱い、v3 の tombstone も in-memory の `Saved` へ復元する。

`storage.rs` は保存時だけ `terminalReceipts[].target` を `terminalReceiptTargets` の辞書へ集約し、各 receipt に `targetIndex` を保存する。同じ完全な target だけを共有し、権限・runtime・workspace・generation 等の field を捨てない。読み込み時には展開して従来の `Saved` を復元する。実行層の API と in-memory の version は変えない。

- 旧 disk v1 を読み込める。形式変換のためだけに読み込み時の書き換えは行わず、次の正常保存で tombstone の有無に応じて v2 または v3 にする。既存の旧 `autoEnabled` 設定の補完が保存を伴う場合も、その保存から v2 になる。
- **v2 または v3 のファイルは、その version を扱わない旧 binary では読めない。** 旧 loader は version 不一致または receipt の形式不一致で拒否する。自動 downgrade は行わない。
- 不正な index、範囲外参照、inline target と index の併存、未参照の辞書要素、壊れた target は拒否する。
- `BufWriter` → 明示 flush → fsync → atomic rename を維持する。変換や保存に失敗しても元ファイルを上書きしない。
- `pending_execution` の target、受理済み prompt / payload、request ごとの context archive は変更しない。

`workRuns` は削除しない。Pi の世代番号が既知の settled request の累積数から求められるため、単純な履歴削除は古い世代の再利用につながる。`terminalReceipts` の証拠本文、`observedKeys` の重複観測防止情報、handoff 記録もこの変更では削除しない。したがって、辞書化と会話整理を導入しても保存全体の増加を止める保証はない。

## 採用しない方式と今後の境界

- 日付や件数だけによる一括削除：未完了の依頼・訂正の根拠を失う。
- 整理のための別モデル処理：既存の判断へ付随できるため、定期的な追加呼び出しを設けない。
- 終了した実行記録の単純削除：世代番号・重複防止・復旧証拠の契約を先に分離する必要がある。
- context の上限を保存の上限として扱うこと：表示の省略と原文の保持を混同する。

今回の整理は、全保存領域の容量管理、過去の Pi session DB の削除、使用量の請求集計を実装するものではない。今後の容量上限は、復旧・世代番号・今回のメモリー削除とは別の原文削除・記憶 pin の解除を含めて別に設計する。

## 実装と検証

- [`continuity/forgetting.rs`](../../src-tauri/src/continuity/forgetting.rs)：メモリーと直接関連する振り返りの削除、出典に基づく再登録防止。
- [`continuity/explicit_memory.rs`](../../src-tauri/src/continuity/explicit_memory.rs)：明示的な記憶依頼と参照候補の原文保護。
- [`continuity/execution_context.rs`](../../src-tauri/src/continuity/execution_context.rs)：必須の根拠を守る実行 context の選択と byte 予算。
- [`continuity/retention.rs`](../../src-tauri/src/continuity/retention.rs)：削減条件と出典保護。
- [`continuity/mod.rs`](../../src-tauri/src/continuity/mod.rs)：モデル返答の検証、判断 trigger、保存・rollback。
- [`continuity/storage.rs`](../../src-tauri/src/continuity/storage.rs)：v1 / v2 / v3 の移行、対象辞書、atomic save。
- [`voice-continuity.ts`](../../src/core/global-prompt/voice-continuity.ts)：音声と terminal bootstrap が共有する短い表示の予算。
- [`journal-fragment.ts`](../../src/core/global-prompt/journal-fragment.ts)：独立した journal の global prompt への追加。
- [`runtime/pi-worker/protocol.mjs`](../../runtime/pi-worker/protocol.mjs)：Pi harness と複数 turn の実行境界。
- [runtime-frame-budget.md](runtime-frame-budget.md)：保存の同期 write による停止の原因と、その修正。

回帰確認は `cargo test --manifest-path src-tauri/Cargo.toml continuity::` と `npx vitest run src/core/global-prompt/voice-continuity.test.ts`。期限・件数の境界、出典と未完了処理の保護、不正な整理 ID、保存失敗の rollback、明示的な記憶依頼の検出と原文保護、実行 context の必須情報・byte 予算・経路別の取得契約、target 全 field の往復、壊れた辞書の拒否、音声の UTF-8 予算と省略表示を確認する。「忘れる」の確認・取消・失敗時の再試行、保存失敗の原状維持、処理中／再起動後の復活防止、元会話の保持と後日の通常整理、disk v3 と旧 version の境界、削除記録が多い場合の表示予算も確認する。個人の会話本文や使用量の集計は fixture / 設計記録へ転記しない。

### 保存の CPU 計測

2026-11-14 に、実際の `encode_saved` と同じ変換を使う一時的な独立 Rust プログラムで、約 2 MB の合成データを比較した。旧方式・辞書化とも `BufWriter` 付きの counting sink へ書き、1 回の warmup 後に順番を交互にした各 21 回の中央値を使った。辞書化側には Value 変換・重複排除・serialization・一時 Value の破棄を含める。

| 合成 fixture | 旧 buffered の bytes → v2 bytes | release 中央値（旧 → v2） | debug 中央値（旧 → v2） |
| --- | ---: | ---: | ---: |
| 329 発言・1,238 実行・14 記憶・373 receipts、target は 14 種類 | 2,130,973 → 1,157,147 | 0.890 → 2.004 ms | 50.551 → 35.457 ms |
| 同じ件数の発言・実行・記憶、長い発言本文、receipt なし | 2,143,679 → 2,143,711 | 0.784 → 1.379 ms | 50.692 → 52.983 ms |

この計測は serialization の CPU と生成 bytes の比較に限る。実際の `Saved` 全 field の分布、ディスク書き込み・fsync、ネットワーク、モデル処理、UI frame 時間は測っていない。個人の保存データは使用していない。辞書化は optimized build でも追加 CPU を使うため、容量削減だけから高速化や一定の frame 時間を保証しない。恒久的な timing assertion は追加していない。

## 改訂履歴

- 2026-11-14：レビュー済み発言だけの整理、明示的な記憶依頼の原文保護、音声と実行 context の上限、disk v2 の可逆な target 辞書化を記録。
- 2026-11-14：利用者向け名称を「ジャーナル」のまま継続し、同機能の改善として扱う方針を確定。将来廃止する対象を従来の日記保存実装として明確化。

- 2026-11-14：メモリーの「忘れる」を、保存済み記憶の削除と出典に基づく再登録防止として定義。元会話・実行履歴・送信済み情報との境界を明記。
