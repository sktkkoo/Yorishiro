/**
 * ~/.yorishiro/init.js — Yorishiro startup script.
 * Yorishiro の起動時スクリプトです。
 *
 * The default-exported function runs at startup and after saved changes are hot reloaded.
 * default export の関数は起動時と保存後の hot reload で実行されます。
 *
 * ctx provides / ctx で使えるもの:
 *
 *   ctx.registerEffect(def)    : register an inline EffectDefinition
 *   ctx.registerPersona(def)   : register an inline PersonaDefinition
 *   ctx.dispatchEffect(request): run a registered effect once
 *   ctx.setActiveUi(id | null) : switch the active UI pack
 *   ctx.emitEvent(name, payload): emit a synthetic event to persona/amenity triggers
 *   ctx.registerShortcut(spec, handler): bind a keyboard shortcut (auto-cleaned on reload)
 *   ctx.onDispose(cleanup)     : run cleanup when this init scope is replaced/torn down
 *
 * This template installs starter keyboard shortcuts.
 * このテンプレートでは最初からいくつかのショートカットを登録します。
 *
 *   - F1: toggle yorishiro-settings
 *   - F3: toggle theater (chrome+terminal hidden, character fullscreen)
 *   - F4: toggle immersive (terminal background transparent, character behind text)
 *   - Cmd+Shift+F: fireworks-volley
 *   - Cmd+Shift+G: desaturate toggle
 *   - Cmd+Shift+P: clai:shoot (gun motion + text physics)
 *
 *   F2 is reserved by Yorishiro for the Common / Scene debug panels.
 *   Do not rebind it from init.js.
 *   F2 は Yorishiro の Common / Scene debug panel 用に予約されています。
 *   init.js から F2 を上書きしないでください。
 *
 * Delete the keydown listener if you do not want these shortcuts.
 * 不要な場合は registerShortcut の行を削除してください。
 *
 * ctx.registerShortcut is the recommended way to bind keys: it captures the
 * keydown before the terminal, calls preventDefault + stopImmediatePropagation
 * by default, and is removed automatically when init.js is reloaded. You can
 * still use window.addEventListener directly — if you do, pair it with
 * ctx.onDispose so reloads do not stack duplicate listeners.
 * init.js IS hot reloaded: save this file and Yorishiro re-runs it. No restart
 * needed. Ask through `/yori` or read the Yorishiro plugin command docs.
 * ctx.registerShortcut がキー登録の推奨手段です。端末より先に keydown を捕まえ、
 * 既定で preventDefault + stopImmediatePropagation し、init.js の再読込時に自動で
 * 解除されます。window.addEventListener を直接使う場合は ctx.onDispose と
 * 組み合わせて、再読込で listener が二重化しないようにしてください。
 * init.js は hot reload されます。保存すると Yorishiro が再実行します（再起動不要）。
 * 例は `/yori` に聞くか、Yorishiro plugin command docs を参照してください。
 *
 * Yorishiro writes this file only when it does not exist. After that, it is
 * yours to edit.
 * Yorishiro はこのファイルが存在しない場合だけ書き込みます。
 * 以後はユーザーが自由に編集できます。
 */

let desaturated = false;

// Toggle a UI pack from its *actual* active state rather than a local flag.
// Keeps F1/F3/F4 in sync even when the pack is dismissed another way (e.g.
// closing the fullscreen view with the title-bar sidebar button), so a single
// keypress always re-opens it.
// 実際の active UI からトグルする（ローカル真偽値ではなく）。タイトルバーの
// サイドバーボタンなど別経路で閉じられても状態がズレないので、キー 1 回で必ず開き直せる。
const toggleUi = (ctx, id) => {
  const active = ctx.getActiveUi();
  ctx.setActiveUi(active === id ? null : id);
};

export default (ctx) => {
  ctx.registerShortcut({ code: "F1", repeat: false }, () =>
    toggleUi(ctx, "yorishiro-settings"),
  );
  ctx.registerShortcut({ code: "F3", repeat: false }, () => toggleUi(ctx, "theater"));
  ctx.registerShortcut({ code: "F4", repeat: false }, () => toggleUi(ctx, "immersive"));

  ctx.registerShortcut({ code: "KeyF", meta: true, shift: true }, () =>
    ctx.dispatchEffect({ kind: "fireworks-volley" }),
  );

  ctx.registerShortcut({ code: "KeyG", meta: true, shift: true }, () => {
    desaturated = !desaturated;
    ctx.dispatchEffect({
      kind: "desaturate",
      durationMs: desaturated ? 86400000 : 1,
    });
  });

  ctx.registerShortcut({ code: "KeyP", meta: true, shift: true }, () =>
    ctx.emitEvent("clai:shoot", { source: "shortcut", key: "Cmd+Shift+P" }),
  );
};
