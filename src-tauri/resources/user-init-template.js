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
 *
 * This template installs starter keyboard shortcuts.
 * このテンプレートでは最初からいくつかのショートカットを登録します。
 *
 *   - F1: toggle charminal-settings
 *   - Cmd+Shift+F: fireworks-volley
 *   - Cmd+Shift+T: text-physics
 *   - Cmd+Shift+D: desaturate toggle
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
let settingsVisible = false;

export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!e.repeat && e.code === "F1") {
        e.preventDefault();
        e.stopImmediatePropagation();
        settingsVisible = !settingsVisible;
        ctx.setActiveUi(settingsVisible ? "charminal-settings" : null);
      }
      if (e.metaKey && e.shiftKey && e.code === "KeyF") {
        e.preventDefault();
        e.stopImmediatePropagation();
        ctx.dispatchEffect({ kind: "fireworks-volley" });
      }
      if (e.metaKey && e.shiftKey && e.code === "KeyT") {
        e.preventDefault();
        e.stopImmediatePropagation();
        ctx.dispatchEffect({
          kind: "text-physics",
          origin: { x: 0.5, y: 0.7 },
          force: 100,
        });
      }
      if (e.metaKey && e.shiftKey && e.code === "KeyD") {
        e.preventDefault();
        e.stopImmediatePropagation();
        desaturated = !desaturated;
        ctx.dispatchEffect({ kind: "desaturate", durationMs: desaturated ? 86400000 : 1 });
      }
    },
    { capture: true },
  );
};
