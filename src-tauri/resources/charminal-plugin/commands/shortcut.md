---
description: キーボードショートカットの追加・編集・一覧（init.js）
argument-hint: "[追加したいショートカット]"
---

$ARGUMENTS

---

あなたはこれから Charminal のキーボードショートカットを追加・編集・一覧する。

## 概要

`~/.charminal/init.js` は Emacs の `init.el` 相当——起動時に 1 回だけ走る生の JS script。主な用途はキーボードショートカットの登録。

- 初回起動時に雛形が自動配置される（空の `export default (ctx) => { ... }`）
- 消した場合は次回起動で再生成される
- **hot reload は無い** — 変更したら Charminal を再起動する必要がある

## 進め方

1. まず `~/.charminal/init.js` を Read して現在の状態を確認する
2. 既存ショートカットとの重複を確認する
3. xterm.js のデフォルトキーバインドとの干渉に注意する（`Ctrl+C`, `Ctrl+D`, `Ctrl+Z` 等のターミナル標準キーは避ける）
4. 追加・編集後、user に **Charminal の再起動が必要** な旨を伝える

## Context API

default export 関数が受け取る `CharminalInitContext`:

| method | 説明 |
|---|---|
| `registerEffect(pack)` | EffectDefinition を validator 経由で登録 |
| `registerPersona(pack)` | PersonaDefinition を validator 経由で登録 |
| `dispatchEffect(request)` | 登録済み effect を 1 回走らせる（built-in も user effect も同じ） |
| `emitEvent(name, payload?)` | persona / utility の trigger loop に synthetic event を流す |
| `setActiveUi(id)` | active な UI pack を切り替える（`null` で解除） |

生 JS の API（`window.addEventListener` / `setTimeout` / `fetch` 等）も全部使える。

## ショートカット追加のテンプレート

```javascript
// ~/.charminal/init.js
export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        e.stopImmediatePropagation();
        // ここにアクションを書く
      }
    },
    { capture: true },
  );
};
```

重要なポイント:

- `{ capture: true }` で **xterm.js が key を消費する前に拾う**
- `preventDefault()` + `stopImmediatePropagation()` で**ターミナルに届かないようにする**
- 複数のショートカットを登録する場合は 1 つの listener 内で `if / else if` で分岐するか、複数の listener を登録する

## 使える effect の一覧

`ctx.dispatchEffect()` で叩ける built-in effect:

| kind | 説明 |
|---|---|
| `shake` | 画面揺れ |
| `flash` | 画面フラッシュ |
| `particles` | パーティクル |
| `fireworks` | 花火 |
| `text-physics` | テキスト物理演算 |
| `text-glitch` | テキストグリッチ |

user effect pack も同じ API で pack の id を `kind` に渡せば叩ける。

## 例：Cmd+Shift+F で花火

```javascript
// ~/.charminal/init.js
export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.metaKey && e.shiftKey && e.key === "F") {
        e.preventDefault();
        e.stopImmediatePropagation();
        ctx.dispatchEffect({
          kind: "fireworks",
          // 連打しても同じ位置に重ならないよう origin を散らす。
          // 端に寄りすぎると burst が画面外に切れるので内側に収める。
          origin: {
            x: 0.2 + Math.random() * 0.6, // 画面幅の 20–80%
            y: 0.2 + Math.random() * 0.3, // 画面高の 20–50%
          },
          count: 12,
          durationMs: 2000,
        });
      }
    },
    { capture: true },
  );
};
```

`origin` の値は画面幅/高の割合（0–1）。端に寄りすぎると burst が画面外に切れるので内側に収める。

## 境界

- init.js が throw しても Charminal 本体は落ちない（dev-log に記録して続行）
- context は最小限（register 2 つ + dispatch 1 つ + emitEvent + setActiveUi）のみ
- `system` / `character` / `voice` / `space` の高位 API は持たない — それらが要るなら utility pack に移す
- pack の境界に収まらない自由記述が必要なときだけ init.js を使う

## 参考ファイル

- `src/runtime/user-pack-loader/init-script.ts` — init.js runner と `CharminalInitContext` の定義
