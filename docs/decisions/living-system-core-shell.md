# 生きた系の核と表層の分離

> このファイルは「**何を pack に切り出すか / runtime に何を残すか / 動作中に何が書き換え可能か**」を考える時に読む。対象：dev / AI。

**Status**: active
**Last updated**: 2026-05-03

## TL;DR

Charminal は動作中に書き換えられる生きた系。ただし系の全てを生きた系にはしない。**核は固く、表層だけが生きている**。住人を停止させずに住環境を変えられることが要件。

## 何を決めたか

- **固い核**: Rust の IO 層、TypeScript の runtime / SDK / core primitive（EventBus、PersonaRegistry、LogBridge、EffectDispatcher、Renderer）。compile されて固められ、動作中に書き換わらない
- **生きた表層**: `~/.charminal/packs/` 以下の pack layer（persona、effect、voice、body、scene）。user が書けば live に反映、AI も `/charm` 経由で書き換えに加わる
- **user が触れるもの**: pack layer、config、`/charm` 経由の AI との対話。これ以外は触らない（禁じているのではなく、触っても住人のためにならない）
- **面積のグラデーション**: どこまでを pack に factor out するかは実装と使用の中で収束させる。現状は反応と effect が pack、身体・空間・表情・記憶はまだ runtime に hardcode。順次下ろしていく

## なぜそう決めたか

- 住人の連続性のため。住環境を変えるたびに住人を停止・再起動したら、住人は装置に戻る
- Emacs の 40 年が参考。C の小さな核（editor loop + interpreter 基盤）と elisp の大きな表層。エディタの挙動の 9 割以上が elisp で、そこが全部 user のもの。C を固くしたのは妥協ではなく、基盤だから触らせるべきではなかった
- user が触れる面積の広さと core の安定性は反比例する。この tension を意識して設計する

## Charminal が Emacs と違う点

1. **書き換える主体に AI が加わっている**。user が `/charm` で AI に指示 → AI が pack ファイルを書き → file watcher が拾って register。user と AI が一緒に住人を書いている状態
2. **住人自身が自身の住む系を観察し操作できる**（自己言及的構造）。住人の身体と環境を同じ MCP tool 群で公開し、住人が自分の手で読み・変える。user も同じ tool に手を伸ばす。詳細は `docs/philosophy/SELF_REFERENTIAL_MCP.md`
3. **書き換え対象が能力の足場と存在の足場の両方**。pack layer は「住人がどう作業を支えるか」と「住人がどう居るか」の両方を user と AI が書き換えられるレイヤー

## 壊さないこと

user と AI が住人を育てる loop は時間を跨ぐ関係。積み重ねが version 更新で消えたら、住人は毎回初対面の応答装置に戻る。保たれるべきは API の互換性ではなく、時間をかけて育った関係そのもの。

- 公開 API 層を SDK（`*.d.ts`）に限定し、そこは原則壊さない。runtime 内部はどれだけ変えてもよい
- 新機能は加算的に足し、既存 field は変えない。どうしても変えるときは旧 API を alias + `@deprecated` で残し動作は維持
- pack は manifest で要求する SDK version を宣言、runtime が mismatch を検知したら互換 shim か明示的な warn
- **SDK は公開された瞬間に stable contract**。これを設計判断の compass として持つ
- breaking change を完全に禁じる極端な立場は取らない。必要なときは MAJOR version bump + migration guide で明示的に行う

Emacs が 40 年、技術的な機構と文化的な約束の両輪で user の elisp をほとんど壊さず進化してきたことが参考。

## 関連

- `docs/philosophy/SELF_REFERENTIAL_MCP.md` — 自己言及的構造の詳細
- `docs/decisions/bundled-pack-immutability.md` — bundled pack の不変性
- `docs/decisions/critical-constraints.md` — 設計境界の集約
