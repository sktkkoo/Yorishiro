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
 * ここに書くもの: keyboard shortcut の張り付け、startup animation、reflex
 * 外の発火経路など、pack SDK の境界に収まらない起動時 hook。pack として
 * 書けるものは pack のほうに置く。
 *
 * 使用例（Cmd+Shift+F で fireworks など）は `/charm --help`、または
 * Charminal の charm.md「init.js」section を参照。
 *
 * 本 file は Charminal が初回起動時に雛形として置いたもの。以降 Charminal
 * が上書きすることはないので、自由に編集して良い。
 */
export default (ctx) => {
  // ここに起動時 hook を書く。
};
