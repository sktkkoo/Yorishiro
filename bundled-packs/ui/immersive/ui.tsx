/**
 * immersive — chrome を隠し、キャラを terminal の上に全画面 overlay で重ねる UI pack。
 * sidebar を fullscreen overlay（position:"overlay" = position:fixed）にし、
 * active scene の background / foreground レイヤを opacity 0 に抑制することで、
 * 透過するキャラ canvas 越しに背後の terminal が透ける（作業と住人の共存）。
 *
 * caveat: 不透明な 3D 環境を WebGL canvas に直接描く scene（DOM レイヤでなく
 * R3F geometry 主体の scene）では terminal でなくその環境が透ける。これは
 * 仕様（その場合も没入表現として妥当）。
 *
 * terminal も消したい場合は theater pack。
 * Internal design-record: specs/2026-05-18-shell-named-surfaces-design.md §5-P3
 */

import type { Disposable, UiContext, UiPackDefinition } from "@charminal/sdk";

/** 抑制する scene レイヤ role。character は表示したままにする。 */
const SUPPRESSED_ROLES = ["background", "foreground"] as const;

const immersive: UiPackDefinition = {
  id: "immersive",
  type: "ui",
  layout: {
    sidebar: { width: "fullscreen", position: "overlay" },
    chrome: { visible: false },
  },
  mount(ctx: UiContext, _container: HTMLDivElement): Disposable {
    // active scene の background / foreground レイヤを opacity 0 に落とし、
    // Three.js の透過 canvas 越しに terminal が透けて見えるようにする
    for (const role of SUPPRESSED_ROLES) {
      ctx.scene.updateLayer({ role }, { opacity: 0 });
    }
    return {
      dispose() {
        // pack 非アクティブ化時にレイヤ override を全リセット（scene を元の状態に戻す）
        ctx.scene.resetAll();
      },
    };
  },
};

export default immersive;
