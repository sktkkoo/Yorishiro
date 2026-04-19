/**
 * ~/.charminal/init.js — Charminal の startup script (Emacs の init.el 相当)。
 *
 * default export された関数は、Charminal 起動時に一度だけ呼ばれる。
 * ctx が提供する API:
 *
 *   ctx.registerEffect(def)    : EffectDefinition を inline で登録
 *   ctx.registerPersona(def)   : PersonaDefinition を inline で登録
 *   ctx.dispatchEffect(request): 登録済み effect を 1 回走らせる
 *
 * 初期雛形として以下の keyboard shortcut を仕込んでいる：
 *
 *   - Cmd+Shift+F: fireworks-volley（連発花火）
 *   - Cmd+Shift+T: text-physics（文字崩壊 + 復元）
 *   - Cmd+Shift+D: desaturate（モノクロ/カラー トグル）
 *
 * 不要なら keydown listener ごと削除して良い。option を調整したい場合は
 * 各 effect pack の README.md を参照。
 *
 * keyboard shortcut API は pack SDK に無いので window の keydown を直接
 * subscribe するのが唯一の手段。使い方の相談は `/charm` から AI と対話する
 * か、Charminal repo の
 * `src-tauri/resources/charminal-plugin/commands/charm.md`「init.js」section を
 * 参照。init.js は hot reload されない（Phase 1-c で扱う予定）ので、変更したら
 * Charminal を再起動すること。
 *
 * 本 file は Charminal が初回起動時に雛形として置いたもの。以降 Charminal
 * が上書きすることはないので、自由に編集して良い。
 */

let desaturated = false;

export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
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
