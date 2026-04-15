# Charminal docs

Charminal の公開ドキュメント置き場。

## philosophy/ — 思想

Charminal が「なぜそうあるのか」を語る 3 本。仕様書ではなく作品宣言に近いです。読む順番に厳密な縛りはありませんが、入り口としては:

| 入口 | 内容 | from |
|---|---|---|
| [`philosophy/CHARMINAL.md`](philosophy/CHARMINAL.md) | プロダクトとして何を考えているか — narrative | 起源 → 発見 → 住まうということ → 二つの層 |
| [`philosophy/INHABITED_INTERFACE_PHILOSOPHY.md`](philosophy/INHABITED_INTERFACE_PHILOSOPHY.md) | Inhabited Interface（住まわれる UI）の原理 | 観察の境界 / 独立した時間 / 多人格の住人 ほか |
| [`philosophy/PRESENCE_HARNESS.md`](philosophy/PRESENCE_HARNESS.md) | persona / harness の two-layer 設計論 | Twin-trigger co-emission / Synthetic event ほか |

3 本の関係:

```
Presence Harness（AI と人間の共存関係の設計論）
  └─ Inhabited Interface（住まわれる UI の思想）
      └─ Charminal（ターミナル環境での具体実装）
```

## 内部の設計記録は別 repo

revelations / dry-run / phase plans / specs などの設計プロセスは別 repo [`Charminal-design-record`](https://github.com/) で管理しています（本 repo の親ディレクトリに `../Charminal-design-record/` として置く想定）。

公開していないのは moat のためではなく、内部の思考メモ・試行錯誤・stale な選択肢が混ざっていて、読み手にとって整理されたものではないからです。整理されたものは philosophy/ 側に上がります。
