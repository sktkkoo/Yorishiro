# Presence contract & loud-unavailable — UI pack が presence surface を宣言する

> このファイルは「**presence/sidebar 系 MCP tool がどう routing され、未宣言時にどう振る舞うか**」を確認する時に読む。対象：dev / AI。

**Status**: active（P2 で確定）
**Last updated**: 2026-05-19

## TL;DR

presence は DOM ではなく契約。UI pack が `UiLayout.presence.target` で「AI の存在強度・`ui.sidebar.set` 相当がどの surface をどの bound で動かすか」を宣言する。未宣言なら AI は typed `unavailable`（reason 付き）を受け取り、他 channel（表情 / 滲み出し / aura）へ切り替える。**黙って no-op にしない**。

## 何を決めたか

- **presence は DOM ではなく契約**：`ui.sidebar.set` / `presence.set-intensity` の効果は `UiLayout.presence.target` で宣言された surface へ routing される。`querySelector(".sidebar")` / `--sidebar-width` への直書きは全廃し、host 仲介の `resolvePresenceSurface` 経由を単一 writer とする。
- **loud-unavailable**：active UI pack が `presence.target` を宣言していない場合、`ui.sidebar.set` / `presence.set-intensity` MCP tool は `ToolUnavailable`（reason 付き）を返す。silent no-op にしない。AI はそれを認知し別 channel へ切り替えられる。
- **host 既定（active UI pack 無し）= classic shell**：`HOST_DEFAULT_PRESENCE` target `"shell"` を host が保持。`?? querySelector(".shell-column")` のような silent fallback は presence / sidebar / attention 経路から全廃。
- **`--sidebar-width` は host 既定 presence の内部実装詳細に降格**：default-shell pack への完全移譲は P4。P2 時点では host が `"shell"` surface として classic 配置を保持し既定挙動を不変にする。
- **単一 writer**：surface mutation は host 仲介の `resolvePresenceSurface` 経由。pack の `ctx.layout` と MCP handler が同一 surface contract を共有する（Symmetry principle）。
- **SDK 宣言と MCP が同一 surface contract を共有**：`UiLayout.presence.target` 宣言は pack 作者（SDK `ctx.layout`）と AI（MCP tool）の両方から参照される同一の契約。

## なぜそう決めたか

- **AI の presence が custom layout で黙って死ぬのは喪失**：`querySelector(".sidebar")` が null で黙って何も起きない既存挙動は、AI が別 channel へ切り替える機会を奪う。loud-unavailable は「邪魔しない / でも従属もしない」を保ちながら AI に選択肢を与える（feedback_autonomy_without_disruption）。
- **Symmetry**：surface mutation primitive は SDK と MCP に同一物を公開。AI（住人）も pack 作者も同じ surface を名前で操作する（SELF_REFERENTIAL_MCP「経路の有無が境界になる」「対称性」）。
- **cognitive-load lens**：`querySelector` の考古学（どこから呼ばれるか）を消す。surface を名前で引く単一経路が読者の追跡 layer を減らす。

## この決定の implication / 制約

- pack / AI が surface を名前でしか触れない（DOM querySelector 経路を API レベルで塞ぐ）。
- `ui.sidebar.set` は tool 名・引数を後方互換で維持するが、意味論は「active pack の presence target への mutation」。
- default-shell active の既定では常に available（default-shell が presence target を宣言するため）。
- P4 で default-shell pack に classic 配置を完全移譲予定。それまでは host が `"shell"` surface として保持。

## 関連 reference

- 実装: `src/runtime/presence-target/`（pure resolver）、`src/runtime/presence-intensity/presence-intensity.ts`（`ApplyPresenceResult`）、`src/runtime/yorishiro-mcp/tool-handlers.ts`（`ToolUnavailable`）、`src/App.tsx`（`resolvePresenceSurface` / `applyPresenceWidth`）
- 決定境界: [`input-prefill-boundary.md`](input-prefill-boundary.md)（基盤以外はなんでも触れる境界）、[`critical-constraints.md`](critical-constraints.md) §1（surface 境界）
- 思想: `docs/philosophy/PHILOSOPHY.ja.md`「観察の境界」「対称性」
- spec: `internal design-record: 2026-05-18-shell-named-surfaces-design.md §4`（loud-unavailable 確定経緯）

## 改訂履歴

- 2026-05-19: P2 で確定。presence 契約型 / pure resolver / loud-unavailable / single-writer を新規 decision として記録。
