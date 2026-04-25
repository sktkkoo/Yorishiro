# Semantic-priority attention

**Status**: active
**Last updated**: 2026-04-25
**Related**: `docs/decisions/critical-constraints.md`、`docs/philosophy/INHABITED_CHARACTER_INTERFACE.md`「観察の境界」

## 結論

Attention runtime に流れ込む target は、**意味を持った観察対象** に限定する。

具体的に attention を emit する semantic (Phase 1b producer 6 種):

- `terminal:diagnostic` (priority 8): エラー / 警告行 (最も強い)
- `terminal:file-link` (priority 5): file path 言及行
- `tool-running` (priority 6) / `tool-diagnostic` (priority 8): ツール実行 / 失敗
- `mcp-tool-request` (priority 6): MCP tool request 到着
- `mouse` (priority 4): user の click (interactive target なら element rect)
- `input-cursor:typing` (priority 3) / `:sent` / `:activate` (priority 5): 入力 caret / Enter pulse

**emit しない**もの (= 意味を持たない観察対象):

- `recent-output`: PTY に何か出力された (内容問わず)
- `focused-dom`: DOM focus が動いた (ユーザー操作と意味の対応が薄い)
- `cursor-position`: マウスが動いた (click でない単なる移動)

## なぜ

- 「Charminal は実在感を主、演出を従」(`feedback_charminal_presence_over_spectacle.md`)。住人は **観察者** であり、ノイズに反応する観察者は実在感を弱める
- recent-output / focused-dom / cursor-position に反応する設計は v1 で試した結果、aura が「常に何かに視線を向けている」状態になり、**「視線の意味」が薄くなった** (3 観点 review 集約: `2026-04-25-attention-aura-v2-design.md`「v1 で何が壊れていたか」)
- 意味判定は producer 側に置く (`auraVisualForTarget` / `Aura` component は kind / reason を受けて style を返すだけ)。runtime / aura 自体に意味判定を入れると **責務が滲む**

## 適用ガイド

- 新 producer を足すとき: 「このイベントは住人が **見る価値** があるか」を最初に問う。「ある」と即答できないなら emit しない
- priority 設計: 高い priority は「意味が強い (= 住人が反応すべき)」、低い priority は「意味が弱い (= 他に強い target が無い時だけ出る)」。recent-output 系の弱い意味は priority 1-2 ではなく **emit しない**
- `priority` は 1-10 の整数で resolver が比較するだけ。設計時は kind 間の相対順序を意識し、同 kind 内の細分割で 0.x を使うような設計はしない (整数で抑える)

## Reference

- 内部 design-record: `../Charminal-design-record/2026-04-25-attention-aura-v2-design.md`「v2 の根幹原則」section
- Memory: `feedback_charminal_presence_over_spectacle.md`、`feedback_interaction_is_presence.md`
- Phase 1b producer 実装: `src/runtime/attention-producers/`

## 関連 critical constraints

- 「Ambient-ui pack に attention の write 権限を渡さない」(`docs/decisions/critical-constraints.md`)
- 「Producer が emit する target には reason field を埋め、aura はそれを style に map する」(`auraVisualForTarget` の責務分離)
