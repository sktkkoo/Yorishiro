# Loop Reel P0

Loop Reel は、自律 loop の lifecycle と live PTY output を host 側で観察し、あとから手動で再生するための記録層です。

- 記録対象: PTY text、terminal resize、session marker、loop phase。highlight / digest / voice / cinema 自動再生は P0 対象外。
- 永続化先: `~/.yorishiro/loop-reels/<recording-id>/meta.json` と `entries.jsonl`。player を開くまでは entries を読みません。
- store / disk は常に raw を保持します。redaction は player が replay terminal へ渡す直前の view 変換で、raw 記録を書き換えません。
- redaction source は Rust command から username / home basename / hostname / global git user name / email を取得し、同じ文字数の `*` で置換します。
- replay は PTY に接続しない xterm overlay です。live PTY は止めず、入力も送りません。
- iteration clips は phase entry から導出します。phase entry が無い手動録画では clip を捏造せず、scrub / play だけを提供します。
