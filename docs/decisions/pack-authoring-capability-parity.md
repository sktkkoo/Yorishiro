# Pack authoring capability parity

> このファイルは「bundled Pack が使う能力を local user Pack にも公開すべきか」を判断する時に読む。対象：dev / AI / Pack API reviewer。

**Status**: active
**Last updated**: 2026-08-12

## TL;DR

Bundled Pack が reference implementation として正式利用する**ユーザーから見える表現能力**は、原則として local user Pack にも stable な public host API で提供する。ただし、同じ source path や内部 module を公開するのではなく、能力を Yorishiro 所有の契約へ翻訳する。

Security、host ownership、compatibility、platform、resource の具体的理由があるものだけを例外とする。local Pack は現在 `trusted-main-thread-js` であり、この parity は sandbox の主張ではない。

## 何を決めたか

### 1. Parity は source parity ではなく semantic capability parity

判断単位は import path や component 名ではなく、Pack 作者が実現できる結果である。

- bundled scene が post-processing、controls、attention cue を正式な表現として使うなら、local scene にも対応する public contract を用意する。
- bundled code が relative import できること、Vite plugin を使えること、内部 registry を参照できることだけでは public API 化の根拠にならない。
- bundled と local で build 経路が違っても、作者から見た supported capability と failure semantics は一致させる。

### 2. Public exposure を4分類する

| 分類 | 方針 | 例 |
|---|---|---|
| Third-party host module bridge | host と Pack が package namespace / instance を共有する必要がある場合、対象 package の public API を bridge する | React、Three.js、R3F、postprocessing |
| Host-owned semantic API | lifecycle、ownership、failure semantics を host が持つ最小 API に翻訳する | controls、attention cue、asset resolver、amenity service |
| System-owned privileged exception | app 本体と同じ release / review 単位でだけ許可し、通常 Pack の前例にしない | settings、updater、native picker、raw Tauri |
| Not yet demanded | bundled reference が正式利用しておらず、実需要もない能力は先回りして公開しない | 未使用 addon、任意 npm package、将来の GPU primitive |

例外にする場合は「internal だから」だけで終わらせず、security、host ownership、compatibility、platform、resource のどれが理由かを decision または contract test に残す。

### 3. 共通化は stable な最小 envelope に留める

複数 Pack が同種の能力を必要としても、個別 protocol まで一つの巨大 API に統合しない。共通に安定保証できる discovery、lifecycle、failure semantics だけを固定し、Pack 固有の state shape、command、payload、version は個別 contract に置く。

Amenity service はこの規則の reference である。共通保証は `get(id)`、`getState()`、`execute(command, params?)` と inactive 時の失敗だけで、Pomodoro 固有の state / command は Pomodoro 自身が所有する。

### 4. Bundled reference 自身も public 経路を使う

public API を用意した後も bundled Pack が内部 import を使い続けると、SDK の破損を製品内で検出できない。権限例外でない bundled reference は public import / context を使い、local runtime と generated `sdk.d.ts` を含む conformance test で維持する。

## なぜそう決めたか

Bundled Pack は Pack authoring の見本でもある。製品内の reference だけが使える表現を増やすと、次の三つが分裂する。

1. ユーザーとAIに説明する SDK の約束
2. Yorishiro 自身が dogfood している実装
3. local runtime compiler が実際に実行できる範囲

この分裂は通常の unit test では見つかりにくく、実際に post-processing は bundled Vite build では動く一方、local TSX runtime では import できなかった。semantic parity を decision として固定し、例外を明示することで、silent drift を review 可能な差分へ変える。

一方、全内部 module の公開は Pack を runtime 構造へ結合し、privileged capability と mutable registry まで漏らす。必要なのは内部実装の複製ではなく、host が継続保守できる意味的な窓口である。

## 検討したが却下した代替案

- **Bundled が import するものをすべて allowlist に足す** — raw Tauri、内部 registry、app component まで public ABI になり、ownership と権限境界を失う。
- **Issue になった symbol だけ個別 shim する** — package update や別の bundled reference で同じ drift を繰り返す。第三者 package bridge と host-owned semantic API を分けて保守する。
- **Bundled Pack は本体コードなので user Pack と違ってよい、とだけする** — reference implementation と authoring contract が分裂し、ユーザーが製品内の表現を再現できない。
- **Parity を sandbox enforcement とみなす** — same-realm の supported API contract は権限分離ではない。community / untrusted execution は別 decision の対象である。

## この決定の implication / 制約

- 新しい bundled 表現能力を追加する PR は、local authoring contractへの公開可否を確認する。
- public にする場合は bundled reference をその経路へ移し、local runtime regression testを加える。
- public にしない場合は具体的な例外理由と ownership を記録する。
- shared React / R3F / Three instance、Pack containment、unknown bare import の fail-closed を維持する。
- raw Tauri、任意 npm import、cross-Pack relative import、mutable registry は parity の shortcut にしない。
- resource budget、GPU/platform compatibility、community distribution、sandbox はこの決定の保証外である。

## 関連 reference

- [`local-source-authoring-contract.md`](local-source-authoring-contract.md)
- [`system-settings-privileged-boundary.md`](system-settings-privileged-boundary.md)
- [`ambient-ui-amenity-service-boundary.md`](ambient-ui-amenity-service-boundary.md)
- [`scene-controls-api.md`](scene-controls-api.md)
- [`pack-execution-classes.md`](pack-execution-classes.md)
- [`pack-sandbox-strategy.md`](pack-sandbox-strategy.md)
- `src/runtime/user-pack-loader/tsx-transpiler.ts`
- `src/sdk/bundled-scene-authoring-contract.test.ts`
- `src/sdk/bundled-sdk-dts.test.ts`

## 改訂履歴

- 2026-08-12: 初版。bundled/local の能力差を semantic capability parity として固定し、公開分類、例外理由、minimum stable envelope、sandbox との非同一性を記録。
