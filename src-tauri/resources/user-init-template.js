/**
 * ~/.charminal/init.js — Charminal startup script.
 * Charminal の起動時スクリプトです。
 *
 * The default-exported function runs once when Charminal starts.
 * default export の関数は Charminal 起動時に 1 回実行されます。
 *
 * ctx provides / ctx で使えるもの:
 *
 *   ctx.registerEffect(def)    : register an inline EffectDefinition
 *   ctx.registerPersona(def)   : register an inline PersonaDefinition
 *   ctx.dispatchEffect(request): run a registered effect once
 *   ctx.setActiveUi(id | null) : switch the active UI pack
 *   ctx.emitEvent(name, payload): emit a synthetic event to persona/amenity triggers
 *
 * This template installs starter keyboard shortcuts.
 * このテンプレートでは最初からいくつかのショートカットを登録します。
 *
 *   - F1: toggle charminal-settings
 *   - F3: toggle theater (chrome+terminal hidden, character fullscreen)
 *   - F4: toggle immersive (terminal background transparent, character behind text)
 *   - Cmd+Shift+F: fireworks-volley
 *   - Cmd+Shift+G: desaturate toggle
 *   - Cmd+Shift+P: clai:shoot (gun motion + text physics)
 *
 *   F2 is reserved by Charminal for the Common / Scene debug panels.
 *   Do not rebind it from init.js.
 *   F2 は Charminal の Common / Scene debug panel 用に予約されています。
 *   init.js から F2 を上書きしないでください。
 *
 * Delete the keydown listener if you do not want these shortcuts.
 * 不要な場合は keydown listener を削除してください。
 *
 * There is no dedicated keyboard shortcut API in the pack SDK, so direct
 * window keydown subscription is the supported path. Ask through `/charm`
 * or read the Charminal plugin command docs for examples.
 * init.js is not hot reloaded; restart Charminal after editing.
 * pack SDK には専用の keyboard shortcut API はありません。
 * window の keydown を直接 subscribe するのが現在の対応方法です。
 * 例は `/charm` に聞くか、Charminal plugin command docs を参照してください。
 * init.js は hot reload されません。編集後は Charminal を再起動してください。
 *
 * Charminal writes this file only when it does not exist. After that, it is
 * yours to edit.
 * Charminal はこのファイルが存在しない場合だけ書き込みます。
 * 以後はユーザーが自由に編集できます。
 */

let desaturated = false;

// Toggle a UI pack from its *actual* active state rather than a local flag.
// Keeps F1/F3/F4 in sync even when the pack is dismissed another way (e.g.
// closing the fullscreen view with the title-bar sidebar button), so a single
// keypress always re-opens it. ctx.getActiveUi may be absent on older Charminal
// builds — fall back to null (always open).
// 実際の active UI からトグルする（ローカル真偽値ではなく）。タイトルバーの
// サイドバーボタンなど別経路で閉じられても状態がズレないので、キー 1 回で必ず開き直せる。
// 旧ビルドには ctx.getActiveUi が無いことがある——その場合は null（常に開く側）。
const toggleUi = (ctx, id) => {
  const active = ctx.getActiveUi ? ctx.getActiveUi() : null;
  ctx.setActiveUi(active === id ? null : id);
};

export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.repeat && e.code === "F1") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleUi(ctx, "charminal-settings");
      }
      if (!e.repeat && e.code === "F3") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleUi(ctx, "theater");
      }
      if (!e.repeat && e.code === "F4") {
        e.preventDefault();
        e.stopImmediatePropagation();
        toggleUi(ctx, "immersive");
      }
      if (e.metaKey && e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopImmediatePropagation();
        ctx.dispatchEffect({ kind: "fireworks-volley" });
      }
      if (e.metaKey && e.shiftKey && e.code === "KeyG") {
        e.preventDefault();
        e.stopImmediatePropagation();
        desaturated = !desaturated;
        ctx.dispatchEffect({
          kind: "desaturate",
          durationMs: desaturated ? 86400000 : 1,
        });
      }
      if (e.metaKey && e.shiftKey && e.code === "KeyP") {
        e.preventDefault();
        e.stopImmediatePropagation();
        ctx.emitEvent("clai:shoot", {
          source: "shortcut",
          key: "Cmd+Shift+P",
        });
      }
    },
    { capture: true },
  );
};
