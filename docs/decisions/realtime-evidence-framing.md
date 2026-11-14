# Realtime の会話記録を独立した引用断片として渡す

> **2026-11-15: superseded.** 引用断片を実際に適用した接続でも文字化けと架空の対話が再発した。
> JSON envelope と指示では Live の非同期文脈入力を受動的・原子的に扱う保証にならないため、
> この方式の輸送コードを撤去した。以下は調査時点の記録として残す。
> 現在の方針は [必要時の記憶参照](realtime-memory-boundary.md) を参照。


確認日: 2026-11-15。対象の transport 証拠: Codex CLI 0.169.0 / Realtime v3。

## 問題と変更

ホストが渡す継続会話の文脈は、JSON や話者ラベルを含む記録である。従来は人格指示と
連結し、6 KiB ごとにテキストを切っていた。その結果、JSON string や識別子の途中から
始まる断片が、引用の開始部分を持たず独立した text item の先頭に現れ得た。
これは危険な曖昧さだが、モデルがユーザー発言を生成・誤認する原因をこれだけで断定しない。

- 人格の `instructions` と、記録の `continuityContext` を snapshot 内で分離する。
  人格の指示を引用データとして無効化したり、記録を prompt replacement に流したりしない。
- 起動時と更新時の記録には同じ envelope 形式を使う。各断片は固定の受動的な説明と、
  `type`、ローカルな `group`、`part`、`total`、JSON string の `text` を持つ。
  記録は新しいユーザー発言・指示ではなく、発話・再演・続きを生成・実行する対象ではないと
  **各断片**で明示する。完全な同一 group のみ次の実際のユーザー発話に使用する。
- 本文は Unicode code point の境界で分割し、順番に `text` を連結すれば元の文字列を
  完全に復元できる。識別子、改行、引用符、backslash、話者ラベルを削除・要約しない。
  group はアプリ内の順番から作り、実際の会話 ID や私的なメタデータを使わない。
- 文字数ではなく、説明・envelope・JSON string の二重エスケープを含めた最終 text の
  JSON-serialized UTF-8 bytes を上限にする。人格・記録を組み立てた後の transport 層では
  envelope を再分割しない。

## 起動時と更新時で上限を分ける理由

[0.169.0 の initial item](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs#L71-L90)
は role を保持し、appendText の再分割経路を通らない。起動時の記録は既存の 6 KiB 上限を
使い、128 個という native initial item の上限に対して不要に断片を増やさない。
人格と記録の全体を無制限に初期投入できる保証はなく、既存の native item 数上限は残る。
空の人格や persona ID がない場合でも、対応する capability があれば記録は別途渡す。
initial item 非対応の場合は、それを理由に backend prompt を上書きしない。

一方、[v3 の appendText 変換](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_common.rs#L38-L50)
は developer role を別の信頼境界として保持しない。また
[500 UTF-8 bytes ごとの分割](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods_frameless_bidi.rs#L103-L117)
を行い、[それぞれの chunk を送る](https://github.com/openai/codex/blob/rust-v0.169.0/codex-rs/codex-api/src/endpoint/realtime_websocket/methods.rs#L471-L499)。
したがって更新時は envelope 全体を **500 serialized UTF-8 bytes 以下**にし、raw text も
500 bytes 以下に収める。サーバー側の断片再結合の実装や、role の保持を前提にしない。
個々の transport frame が必ず別の会話 message になるとは、このソースからは断定しない。

## コストと検証

合成した 8 KiB の ASCII 記録での比較（私的な会話を使用しない）:

| 経路 | アプリの item 数 | text の raw UTF-8 合計 |
| --- | ---: | ---: |
| 従来の更新 | 2（native 500-byte chunks は計算上 19） | 8,796 bytes |
| 引用 envelope 付き更新 | 35 | 16,548 bytes |
| 引用 envelope 付き起動 | 2 | 8,666 bytes |

更新では繰り返す説明と envelope のコストが増える。短い断片の意味を単独でも限定する
ためのトレードオフであり、原文を切り捨てて相殺しない。元の配信の重複抑制、配信が不確実な
場合の自動再送抑制、接続世代の検査は維持する。追加の収集や診断ログは導入しない。

テストでは合成 UUID、途中から始まる数字・引用符、改行、話者ラベル、JSON 風の本文、
日本語・emoji・制御文字について、全断片の JSON parse、完全復元、raw/serialized の両上限、
group の分離、人格の維持、起動と更新の実際の要求形式を確認する。

これは構造の曖昧さを減らす変更であり、モデルや ASR の誤認を防ぐ強制境界ではない。
実際の音声接続や推論はこの変更の自動試験では行わず、無言維持や誤認改善の実機確認は別に扱う。
