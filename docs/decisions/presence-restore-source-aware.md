# Presence 自動復帰は source 対応 — user の明示的 close は維持する

> このファイルは「**prompt 送信時に presence がいつ自動で開くか / user が閉じたものがなぜ開いてしまったか**」を確認する時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-06-01

## TL;DR

`user-prompt-submit` 時の presence 自動復帰は **source 対応**にする。住人が自分で引っ込んだ（source `"mcp"`）場合は「呼びかけられればまた顔を出す」で `"default"` に復帰する。一方 **user が UI（設定パネル = source `"settings"`）で明示的に閉じた**場合は、その意思を尊重して `"closed"` を維持し、prompt 送信で勝手に開かない。

## 何を決めたか

- 自動復帰の判定を pure helper `shouldRestorePresenceOnPrompt(state)` に一元化：`!(state.level === "closed" && state.source === "settings")`。
- `onUserPromptSubmit`（canonical）と `src/App.tsx` の `restorePresenceFromPrompt`（実機 / Perception の `onPresenceRestore` 経由）の両経路がこの helper を共有する。判定が二度と分岐しないようにするのが目的。
- `closed && source==="settings"` のときは no-op（previousLevel の bookkeeping もしない＝遷移が起きていない）。
- 住人が MCP（`presence_set_intensity` → source `"mcp"`）から**明示的に**出てくる経路は影響を受けない。明示操作は常に効く。自動復帰だけが source を見る。

## なぜそう決めたか

- philosophy（`docs/philosophy/PHILOSOPHY.ja.md`）の「呼びかけられればまた顔を出す」は **住人発の close** を前提にした挙動。住人が「今は引いていよう」と引っ込み、user の再エンゲージで戻る——これは住人性の証明。
- ところが設定パネルの「Sidebar」トグルは同じ presence level を **user 発（source `"settings"`）** で叩く。そこに住人発と同じ自動復帰を当てると、user が prompt を送る（＝住人とやり取りする）たびに user の明示的な close を上書きしてしまう。
- user の明示的選択を毎 prompt で勝手に覆すのは [`autonomy-without-disruption.md`](autonomy-without-disruption.md)「邪魔しない / でも従属もしない」と [`explicit-over-implicit-ugc.md`](explicit-over-implicit-ugc.md)「explicit な予測可能性」に反する。source で発生源を区別すれば、住人発の温かい復帰と user 発の明示的選択の両方を立てられる。

## 検討したが却下した代替案

- **自動復帰を一律廃止**：住人発の「呼ばれたら顔を出す」は philosophy の核なので残す。一律廃止は住人性を削る。
- **設定トグルを presence-intensity から切り離し、独立した永続 UI 設定（"sidebar collapsed"）にする**：概念的にはより clean（[`separate-distinct-systems.md`](separate-distinct-systems.md)）だが large diff。今回は最小の source-aware guard に留め、分離は future work とする（large-diff は体験 gain で代償を払う原則）。

## この決定の implication / 制約

- 設定パネルの「Sidebar」トグル（`labelPresence: "Sidebar"`）は依然 presence-intensity を source `"settings"` で叩く実装。**UI ラベル（Sidebar）と内部 concept（住人の presence 濃度）の conflation は残存**。将来「user の Sidebar 表示設定」と「住人 presence 濃度」を別系統に分離する余地がある。
- presence level は runtime state（`config.json` 非永続）。再起動で `"default"` に戻る。session 内で「閉じたまま」を保つのが本決定の射程で、永続化は別問題。

## 関連 reference

- 実装: `src/runtime/presence-intensity/presence-intensity.ts`（`shouldRestorePresenceOnPrompt` / `onUserPromptSubmit`）、`src/App.tsx`（`restorePresenceFromPrompt`）、`src/core/perception/perception.ts`（`user-prompt-submit` → `onPresenceRestore`）、`bundled-packs/ui/yorishiro-settings/ui.tsx`（`labelPresence` "Sidebar" → `ctx.app.setPresenceLevel`、source `"settings"`）
- 関連 decisions: [`autonomy-without-disruption.md`](autonomy-without-disruption.md)、[`explicit-over-implicit-ugc.md`](explicit-over-implicit-ugc.md)、[`separate-distinct-systems.md`](separate-distinct-systems.md)、[`presence-contract-loud-unavailable.md`](presence-contract-loud-unavailable.md)（presence の routing / surface 契約。本決定は復帰ライフサイクルで facet が別）

## 改訂履歴

- 2026-06-01: 新規。設定で閉じた sidebar が prompt 送信のたびに開く bug の根本対応として、自動復帰を source 対応にした決定を記録。
