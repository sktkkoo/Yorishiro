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
 * 初期雛形として Cmd+Shift+F に bundled "fireworks-volley" effect pack の
 * 発射を仕込んでいる。連発 / 位置散らし / 間隔 jitter は pack 側で処理
 * されるので、ここでは 1 行 dispatch するだけ。不要なら下の keydown
 * listener ごと削除して良い。
 *
 * option を調整したい場合（本数・位置範囲・間隔など）は
 * `bundled-packs/effects/fireworks-volley/README.md` の options 表を参照。
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

export default (ctx) => {
  window.addEventListener(
    "keydown",
    (e) => {
      if (!(e.metaKey && e.shiftKey && e.code === "KeyF")) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      ctx.dispatchEffect({ kind: "fireworks-volley" });
    },
    { capture: true },
  );
};
