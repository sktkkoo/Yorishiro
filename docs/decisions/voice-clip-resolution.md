# 音声 clip の参照を解決する規約

> このファイルは「**音声 clip ref をどう解決するか / どんな ref を許すか / shared voice 名前空間をどう扱うか**」を決めたときに読む。対象：dev / AI / pack 作者。

**Status**: active（2026-05-25 採用）。shared voice の basename alias と filler 系 voice 同梱は **検証中**。
**Last updated**: 2026-05-25

## TL;DR

`ctx.voice.play(clipRef)` の `clipRef` は 3 種類: `voice:<stem>`（shared library）/ `./...` `assets/...`（pack 同梱）/ `http(s)|asset|blob:`（caller 解決済み URL）。解決順序は **scoped resolver → shared map → playable URL passthrough**。解決失敗は silent ではなく `VoiceHandle.completion` が reject し、`startedAt` は `0` のまま。pack-local ref は path-segment 単位で `.`/`..` を拒否する（security 境界）。

---

## 何を決めたか

### 採用

- `VoiceClipRef` の 3 種類:
  - `voice:<stem>` — `bundled-packs/shared/voices/**` に同梱された共有 voice library
  - `./...` または `assets/...` — 持ち主 persona pack 同梱の WAV（bundled / user 両方）
  - `http(s)://` / `asset://` / `blob:` — caller が解決済みの URL
- 解決順序: scoped resolver（persona-aware）→ shared voice map → playable URL passthrough → null
- 解決失敗は **silent ではない**: `completion` が reject、`startedAt` は `0` のまま。caller は「鳴っていない」を判定できる
- pack-local ref の path safety:
  - `./` または `assets/` prefix のみ許容
  - normalize 後の **全 segment** で `.` `..` を拒否
  - scheme を含む ref（`file:` 等）を拒否
- shared voice map は **stem (`<category>/<name>`) と basename (`<name>`)** の両方を key として登録（basename alias、検証中）

### 検証中 / 未確定

- **shared voice の basename alias**: 現状 `voice:filler_ah` のような basename ref を `voice:<category>/filler_ah` と等価に解決する。filler 系 voice の category 体系が固まれば、call site を category 付きに統一して alias は撤去する想定。当面は filler 検証のため残す
- **filler 系 voice の同梱**: `bundled-packs/personas/clai-shared/persona-factory.ts:263` の `startled` reaction handler が `ctx.voice.play("voice:filler_ah")` を呼ぶ。一方 `bundled-packs/shared/voices/` には対応 WAV を未配置（filler の素材選定・category 設計・録音方針を未確定のまま留めている）。さらに **`startled` reaction を emit する trigger が現状コード上に存在しない**（handler は dead orphan、`clai-shared` の `customTriggers` 4 種いずれも `startled` を返さない、runtime / MCP からの dispatch 経路もなし）。つまり filler は **(a) WAV 未配置 / (b) trigger 未実装 / (c) handler 定義済み** の三層 dormant。WAV だけを `bundled-packs/shared/voices/` に追加しても trigger がないので鳴らない — 逆に言うと trigger を追加した時点で WAV が同梱されていれば即座に鳴り始める。**解除時は WAV 追加と `startled` を emit する trigger 追加をセットで行う**（片方だけ先行させると、handler の orphan 状態が解けて意図しないタイミングで filler が鳴り始める / `completion` reject + `console.error` が連発する、のいずれかが起きる）

### 不採用

- 解決失敗を silent stub に戻す → 「鳴っていないのに鳴ったと見える」regression を生むので不可（VoiceHandle.startedAt を音声同期に使う caller が壊れる）
- pack-local ref で絶対パス / scheme 付き URL を許可 → user pack 境界外への traversal リスク
- LLM 出力からの自動解決 → [voice-as-explicit-tool-call.md](voice-as-explicit-tool-call.md) の明示性原則と衝突

## なぜそうしたか

1. **3 種類の ref を区別する理由**: shared library と pack 同梱は名前空間が違う。shared は再利用可能な共通素材、pack 同梱はその persona の固有素材（録音された歌など）。両者を 1 つの ref に混ぜると、pack 作者が「自分の WAV だけが優先される」と期待しても shared の同名 ref に上書きされる事故が起きる
2. **解決順序の根拠**: scoped を最初にすると pack 作者が自分の同梱 asset を確実に優先できる。shared がその次なら pack で resolve できなかった ref が library で救われる。playable URL は最後で、caller が事前解決済みの URL を直接渡す escape hatch
3. **解決失敗を reject する理由**: caller が音声同期した animation や timing を組むとき、「鳴っていない」を検知できないと wrong sync が起きる。stub の `startedAt: 0` だけが返ってきた旧設計に戻すと、`startedAt > 0` を再生開始シグナルに使う caller が壊れる
4. **path safety を segment 単位にする理由**: user pack は AI が書く init.js 経由でも来る（untrusted code surface）。`./foo/..` のような単純 prefix チェックだけでは pack 境界外への traversal を許す。segment 単位で `.`/`..` を全拒否することで完全に締める
5. **filler を「検証中のまま残す」理由**: call site だけ先に書いておくと、WAV 同梱と category 体系が確定したときに「どこで鳴らすか」の議論を経由せず即時に動作確認できる。先に call site を消すと、復帰時に「どこで鳴らすか」を再考する手間が発生する

## 検討したが却下した代替案

- **filler の call site を削除する**: 復帰時に reaction handler のどこから filler を呼ぶかを再決定する必要があり、現状の startled handler との接続意図が消える
- **shared voice の basename alias を撤去**: filler を category 付き ref（例 `voice:thinking/filler_ah`）に書き直す必要がある。category 体系が未確定なので時期尚早
- **解決失敗を warn 1 回 + silent**: 「鳴っていないのに鳴ったと見える」regression を再導入する

## この決定の implication / 制約

- shared voice library を増やすときは `bundled-packs/shared/voices/<category>/<stem>.{wav,mp3,ogg,m4a}` の階層で置く（basename 衝突は build 時に warn + 後勝ち skip で起動可能、但し意図せぬ alias 上書きが起きる）
- pack-local voice asset は `<pack-dir>/assets/...` または同階層配下に置く。pack 作者は scheme 付き URL や `..` を含む ref を書いてはいけない
- 新しい clip ref scheme を追加するときは `resolveClipUrl()` の優先順位を必ず宣言する（現状 4 段の挿入位置を曖昧にしない）
- filler 検証を解除する条件: (a) WAV の素材選定と category 体系が確定、(b) `bundled-packs/shared/voices/` に同梱、(c) `startled` reaction を emit する trigger を追加（(b) と同時または後）、(d) call site を category 付き ref に統一、(e) basename alias を撤去

## 関連 reference

- shared voice resolver: `src/core/voice/voice-clip-resolver.ts`
- pack-local resolver + path safety: `src/runtime/persona-registry/voice-asset-resolver.ts`
- 解決順序統合: `src/core/voice/voice-player.ts` の `resolveClipUrl()`
- scoped resolver 配線: `src/runtime/persona-registry/real-context.ts`
- filler call site（検証中）: `bundled-packs/personas/clai-shared/persona-factory.ts:263`
- 明示性原則: [voice-as-explicit-tool-call.md](voice-as-explicit-tool-call.md)
- security 境界: [critical-constraints.md](critical-constraints.md)
