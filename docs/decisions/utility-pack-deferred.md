# Utility Pack（旧 Harness Pack）— deferred

## Status

**公開延期中**。SDK 型定義（`UtilityDefinition` / `UtilityContext`）はコードベースに存在するが、user pack loader は utility をサポートしていない。charm コマンド（create / help / update / shortcut）からも utility の記述を削除済み。

復活時は本ドキュメントを参照してコマンド doc を再構成する。

## 改訂履歴

- 2026-04-29: harness → utility にリネーム（PR #28）、同日 charm コマンドから utility の記述を削除

## 概要

utility pack は環境への自動作用（通知、clipboard 操作、タイマー等）を担う pack 種別。persona が「キャラクターの表現」を担うのに対し、utility は「機能的な仕事」を担う。

## 設計仕様

### ファイル構成

```
~/.charminal/packs/<id>/
├── manifest.json
└── utility.js
```

### manifest.json

```json
{
  "id": "my-utility",
  "type": "utility",
  "version": "0.1.0",
  "charminalVersion": "^0.1.0",
  "entry": "utility.js",
  "permissions": {
    "system.exec": true,
    "system.notify": true
  }
}
```

`permissions` は宣言的（MVP では enforce されない）。使う API を明示する役割。

### utility.js

```typescript
import type { UtilityDefinition, UtilityContext } from "@charminal/sdk";

export default {
  id: "my-utility",
  name: "My Utility",
  customTriggers: [
    {
      id: "my-utility:something-failed",
      match: (event) => {
        if (event.kind !== "pty-output") return null;
        if (!/ERROR/.test(event.text)) return null;
        return { reaction: "something-failed" };
      },
    },
  ],
  automations: {
    "something-failed": {
      handlers: [
        {
          handler: async (ctx: UtilityContext) => {
            await ctx.system.notify({
              title: "Something failed",
              body: "",
            });
          },
        },
      ],
    },
  },
} satisfies UtilityDefinition;
```

### active 数

**multi-active**。loaded されればそのまま動く。active 数の制約なし、config key なし。

### 境界（motion-free）

utility は `ctx.character` / `ctx.voice` / `ctx.space` を型レベルで持たない。

- キャラを反応させたい場合 → **Twin-trigger co-emission**: utility の custom trigger が persona 側の reaction（例: `distressed`）も一緒に emit し、persona handler に拾わせる
- handler 内から新 reaction を起こしたい場合 → `ctx.emitEvent(name, payload)` で synthetic event を announce、custom trigger 経由で reaction に変換。handler から直接 reaction を emit する API は型ごと無い

### セキュリティ考慮

utility pack はネットワークアクセス・ファイル読み出し・外部コマンド実行など、他の pack 種別にはない attack surface を持つ。user utility pack を開放する場合、pack ごとの permission model を先に設計する必要がある。

当面は bundled utility pack のみの予定。user utility pack の開放は permission model 確立後。

## bundled utility pack の候補

Sensors（`~/Documents/Sensors/`）に prototype がある:

| 名前 | 概要 | 優先度 |
|---|---|---|
| pomodoro | ポモドーロタイマー（notify 連携） | 高 |
| weather | 天気・傘判定（wttr.in、API キー不要） | 高 |
| play-music | ~/Downloads の音声ファイル再生（afplay） | 中（macOS 限定） |
| notify | macOS 通知センター（即時・予約） | 内部依存（pomodoro 等が使う） |

stamp / figlet は LLM が呼んでテキスト出力する形だったが、ターミナルに直接表示するには PTY write 禁止が壁になる。画像スタンプとして UI overlay に出す方向に転換する可能性あり。

## コマンド doc への復活手順

1. `create.md`: pack 種類テーブルに utility 行を追加、「Utility pack を書く」セクションを復元（本ドキュメントの仕様をベースに）
2. `help.md`: pack 種類テーブル・境界ルール表・SDK 型一覧に utility を追加
3. `shortcut.md`: `emitEvent` の説明に "persona / utility" を復元、境界セクションに utility pack への誘導を復元
4. `update.md`: 「Scene / Effect / UI / Ambient-UI の編集」セクションに utility を追加、fork セクションに utility のパスを追加
