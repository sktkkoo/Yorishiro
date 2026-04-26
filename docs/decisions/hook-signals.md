# Hook signals — 発火タイミングと適切な用途

**Status**: active
**Last updated**: 2026-04-26
**Related**: `src/sdk/reaction.d.ts`、`src/core/perception/perception.ts`、`src-tauri/src/hooks.rs`

## 結論

Charminal は Claude Code 公式 hook lifecycle (`UserPromptSubmit`、`PreToolUse`、`PostToolUseFailure`、`Stop` 等) を install し、SDK 側で `HookSignal["name"]` の kebab-case に mapping する。各 signal の発火タイミングを正しく理解せずに使うと、UI semantic と乖離した実装になる。特に `user-prompt-submit` は user の Enter 押下瞬間ではなく、**次ターン処理開始境界** で fire することは設計判断の根幹に関わる。

## 各 signal の実態

| upstream hook | SDK name | fire timing | 推奨用途 |
|---|---|---|---|
| `PreToolUse` | `pre-tool-use` | tool 呼び出しの直前 | tool 実行検出、診断 aura 等 |
| `PostToolUse` | `post-tool-use` | tool が正常に完了した直後 | 完了検出、完了後の状態遷移 |
| `PostToolUseFailure` | `post-tool-failure` | tool が失敗した直後 | エラー反応、失敗診断 |
| `UserPromptSubmit` | `user-prompt-submit` | **次ターン処理開始境界**（前ターン応答完了後） | ターン境界の状態遷移（Body state → thinking 等） |
| `Stop` | `stop` | Claude 応答完了（ターン終了） | ターン終了検出、idle 状態へ遷移 |
| `Notification` | `notification` | Claude が notification を発行した時 | notification に応じた反応 |

## なぜ user-prompt-submit は遅延するのか

Claude Code は single-turn 序列で動作する。前ターンの応答 streaming 中は次の prompt を受け付けず queue する。

**タイムラインの例** (応答時間が 30 秒の場合):

1. `t=0s`: user が Claude Code の input field で Enter を押下
2. `t=0s`: prompt が queue に入る
3. `t=0s~30s`: Claude が前ターンの応答を streaming、并行で新 prompt の処理はできない
4. `t=30s`: 前ターン応答が完了
5. `t=30s`: Claude が queue から prompt を取り出す
6. **`t=30s`: `UserPromptSubmit` hook fire** ← Charminal 側に `user-prompt-submit` signal が届く

つまり user が Enter を押した瞬間と `UserPromptSubmit` の fire タイミングの間には、**前ターンの応答時間分のラグ** (数秒〜数十秒) が必ずある。

## sent aura の事例（反面教師）

### 背景

Phase 1d で、sent aura（= user が prompt 送信した瞬間に画面上に表示されるビジュアル反応）を実装する際、Claude Code の公式 `UserPromptSubmit` hook を使うのが自然だと考えた。

### 実装（B15: commit 3b6b1a7）

`user-prompt-submit` signal driven の sent aura を実装。ハンドラを当てて、signal 到達時に aura を emit。

### 本番確認時に判明（B16 診断）

実際に使うと「Enter を押してから約 30 秒後に sent aura が画面に出現」という症状が発生。これは ux として明らかに違う — 実際には user が既に次の prompt を考え始めている頃合に、前の操作への反応が遅れて出てくる。

### 根本原因

上記「タイムラインの例」で説明した通り、`UserPromptSubmit` hook の fire タイミングが前ターン応答完了後であるため、30 秒の遅延が避けられない。

### 解決（B17: commit 8e33de6）

sent aura は xterm レベルの event を直接使うように切り替え。具体的には `terminal-runtime.subscribeUserSubmit` を使い、この実装は内部で `xterm.onData("\r")` を監視する。xterm の onData は enter キー（`\r` コード）を synchronously に検出するため、遅延はない。

```typescript
// B17 での実装
terminal.subscribeUserSubmit(({ line }) => {
  // user が実際に Enter を押した瞬間に同期的に fire
  auraContext.emit('sent', { line });
});
```

## 適切な選択指針

### 「user の操作瞬間」を取りたい時

上流 hook（`UserPromptSubmit` 等）ではなく、xterm などの下流 event を使う。

**実装例**:

- **terminal 入力（Enter 押下）**: `terminal-runtime.subscribeUserSubmit(handler)` 使用。内部実装は `xterm.onData` の `\r` 検出
- **一般的なキー入力**: window `keydown` event listener（ただし IME composition state に注意）
- **マウス操作**: window `click` / `pointerdown` 等

### 「Claude のターン境界」を取りたい時

hook signal が正解。タイミングは前ターン完了後なので、前ターン応答に基づく状態遷移に適している。

**実装例**:

- **ターン開始**: `user-prompt-submit` → Body state を `thinking` に遷移
- **ターン終了**: `stop` → idle state へ遷移、ambient gaze など

## SDK type 名を rename しない理由

`user-prompt-submit` という type 名は Claude Code 公式 `UserPromptSubmit` への直接対応であり、外部 plugin 開発者にとって upstream との関係が一目瞭然である。実装上の fire タイミング（= ターン処理開始境界）は public spec に文書化されていないため、Charminal で利用する際は **docstring + decision file で意味を明示** する方針にした（本文書 + `src/sdk/reaction.d.ts` の JSDoc）。

rename する代案も検討したが（例：`turn-start` など）、以下の理由で棄却：

1. **upstream 追跡性**: 問題が upstream に報告される場合、type 名の対応が失われるため debug コスト増
2. **plugin ecosystem**: 将来的に Charminal SDK を expose する際、public type が upstream と一致している方が学習コスト が低い
3. **documentation で十分**: JSDoc + decision file で正確に文書化すれば、意図的な乖離は防ぎやすい

## 参考

- `src/sdk/reaction.d.ts`: `HookSignal["name"]` の JSDoc（各 signal の詳細）
- `src-tauri/src/hooks.rs`: hook install 実装
- commit 8e33de6: B17 sent aura 修正（xterm.onData 駆動への切り替え）
- commit 3b6b1a7: B15 sent aura 初実装（user-prompt-submit 駆動、後に問題判明）
- B18 で sent 機能自体を撤回した。「user の操作瞬間反応」という需要は typing aura（打鍵中の継続表示）で十分担保されており、cost/value で sent の追加実装は割に合わなかった。教訓 — `user-prompt-submit` hook の発火タイミングが「次ターン処理開始境界」であること自体は引き続き本文書の知見として保持する。
