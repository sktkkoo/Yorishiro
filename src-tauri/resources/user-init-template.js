/**
 * ~/.charminal/init.js — Charminal startup script, similar to Emacs init.el.
 *
 * The default-exported function runs once when Charminal starts.
 * ctx provides:
 *
 *   ctx.registerEffect(def)    : register an inline EffectDefinition
 *   ctx.registerPersona(def)   : register an inline PersonaDefinition
 *   ctx.dispatchEffect(request): run a registered effect once
 *   ctx.setActiveUi(id | null) : switch the active UI pack
 *
 * This template installs a few starter keyboard shortcuts:
 *
 *   - F1: toggle charminal-settings
 *   - Cmd+Shift+F: fireworks-volley
 *   - Cmd+Shift+T: text-physics
 *   - Cmd+Shift+D: desaturate toggle
 *
 *   F2 is reserved by Charminal for the Common / Scene debug panels.
 *   Do not rebind it from init.js.
 *
 * Delete the keydown listener if you do not want these shortcuts.
 * See each effect pack README.md for tunable options.
 *
 * There is no dedicated keyboard shortcut API in the pack SDK, so direct
 * window keydown subscription is the supported path. Ask through `/charm`
 * or read the Charminal plugin command docs for examples.
 * init.js is not hot reloaded; restart Charminal after editing.
 *
 * Charminal writes this file only when it does not exist. After that, it is
 * yours to edit.
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
