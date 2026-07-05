# Pack sandbox strategy

**Status**: active
**Last updated**: 2026-06-13

## TL;DR

Store v1 は declarative + 審査 + 署名で launch し、sandbox は blocker にしない。script 実行型 pack を解禁する時だけ、`declarative` → `sandbox: "wasm"` → `sandbox: "native"` の能力ラダーで段階的に上げる。

manifest の `sandbox` は top-level field として予約し、未知 backend / 未知 field は client が fail-closed で reject する。

## 何を決めたか

Store v1 の公開 pack は declarative を中心にする。declarative pack は JS を含まない data であり、封じ込める実行主体が無い。v1 は schema validation、review、署名、revocation で launch し、sandbox 実装を公開 store の blocker にしない。

script 実行型 pack は以下の能力ラダーで扱う。

| 段 | 意味 | 公開配布の扱い |
|---|---|---|
| `declarative` | data-only。JS を評価しない | Store v1 default |
| `sandbox: "wasm"` | 自己完結 runtime。全 OS 同一挙動 | wasm backend 実装後の default |
| `sandbox: "native"` | OS process / local tool に触れる escalation | 強い審査 + capability 同意後に限定 |

上表の `sandbox: "wasm"` / `sandbox: "native"` は能力ラダー上の短縮表記である。manifest の正規形は top-level の `sandbox` object とする。

```json
{
  "$schema": "https://yorishiro.dev/schemas/pack-manifest.schema.json",
  "id": "workspace-tool",
  "type": "amenity",
  "executionClass": "trusted-main-thread-js",
  "entry": "amenity.js",
  "sandbox": {
    "backend": "wasm",
    "fs": { "read": ["~/Documents/foo"], "write": [] },
    "net": ["api.example.com"],
    "runtime": "python3.13-wasi"
  }
}
```

`sandbox` schema は以下の client contract を持つ。

- `backend` は `"wasm"` または `"native"` のみ。
- `fs.read` / `fs.write` は string array。
- `net` は hostname string array。
- `runtime` は string。
- 未知 backend、未知 field、未知 nested field は fail-closed で reject する。
- Phase 0 では schema を先行定義するだけで、全 backend は未実装として reject する。

JSON Schema の正本はストア側 `packages/schema`（`https://yorishiro.dev/schemas/pack-manifest.schema.json`）である。本体側の `pack-sandbox-spec.ts` は client 実装であり、正本 schema の代替ではない。

Mac App Store 配布は前提から除外する。Yorishiro は direct distribution + notarization を前提にし、MAS sandbox には依存しない。MAS sandbox は任意 process spawn / local tool execution と根本的に衝突し、native backend の能力ラダーと整合しない。

## なぜそう決めたか

declarative pack は実行主体を持たないため、sandbox より schema validation と審査が主要な境界になる。sandbox を store v1 の blocker にすると、data-only pack の launch 価値に対して実装負荷が大きすぎる。

一方で script 実行型 pack は、install した瞬間に end user の環境で動き、PTY 出力や local secret への接触機会を持つ。公開配布で script 実行を解禁するなら、審査だけでなく runtime containment が必要である。

wasm を default にするのは、OS 差分を局所化し、capability を静的に検査しやすくするためである。native は user environment に触れる用途のために残すが、審査と同意のコストを明示的に払う escalation とする。

## この決定の implication / 制約

- `sandbox` は `executionClass` と同列の top-level field とする。`execution.sandbox` の nested 形は採用しない。
- 古い client が新しい backend を黙って通すことを防ぐため、未知 field を無視しない。
- Rust 側は manifest summary で `sandbox` を素通しし、schema 解釈は TS 側 policy に寄せる。
- `sandbox` が宣言された pack は、backend enforcement が実装されるまで実行しない。
- Seatbelt / sandbox-exec / SandboxedExecutor は Phase 1 以降の別作業とし、Phase 0 では実装しない。

## 関連 reference

- [`pack-execution-classes.md`](pack-execution-classes.md)
- [`system-exec-trust-model.md`](system-exec-trust-model.md)
- [`mcp-trust-tiers.md`](mcp-trust-tiers.md)
- internal design-record: 2026-06-12-pack-store-sandbox-necessity-proposal.md

## 改訂履歴

- 2026-06-12: 初版。internal design-record: 2026-06-12-pack-store-sandbox-necessity-proposal.md を公開 decision として要約。
