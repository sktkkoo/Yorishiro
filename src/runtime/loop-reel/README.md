# Loop Reel P1

Loop Reel は、自律 loop の lifecycle と live PTY output を host 側で観察し、あとから手動 replay / catch-up するための記録層です。

- 記録対象: PTY text、terminal resize、session marker、loop phase。marker は session 系に加えて user intervention / failed command を持ちます。highlight / digest / voice / cinema 自動再生は対象外。
- 永続化先: `~/.yorishiro/loop-reels/<recording-id>/meta.json` と `entries.jsonl`。player を開くまでは entries を読みません。
- 録画中 recording は catch-up で選択できます。開始時に対象 recording だけ flush して disk 全量を読み、以後の live tail は store の append event を replay terminal へ合流します。
- catch-up は dead-time gap を短く圧縮して既定 2x で自動再生し、live edge に到達したら pause します。新 entry への自動追従再生はしません。
- store / disk は常に raw を保持します。redaction は player が replay terminal へ渡す直前の view 変換で、raw 記録を書き換えません。
- redaction source は Rust command から username / home basename / hostname / global git user name / email を取得し、同じ文字数の `*` で置換します。
- replay は PTY に接続しない xterm overlay です。live PTY は止めず、入力も送りません。
- iteration clips は phase entry から導出します。phase entry が無い手動録画では clip を捏造せず、scrub / play だけを提供します。
- 既知制限: lifecycle 録画の session 帰属が fallback session になった場合、別 sessionId の command-block marker は active recording に紐づかず drop されます。
