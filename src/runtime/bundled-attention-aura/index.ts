/**
 * Bundled attention-aura pack の register helper。
 *
 * Phase 1d で App.tsx の起動 path から `registerBundledAttentionAura({ registry })` を
 * 呼び、ambientUiPackRegistry に bundled aura を登録する。`config.json` の
 * `activeAmbientUi` に "attention-aura" が含まれていれば registry が enable する。
 *
 * Internal design-record: 2026-04-25-attention-aura-v2-design.md
 *   「Factory default の決め方」
 */

import type { Disposable } from "@yorishiro/sdk";
import attentionAuraPack from "../../../bundled-packs/ambient-ui/attention-aura/ui";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";

interface RegisterOptions {
  readonly registry: AmbientUiPackRegistry;
}

export function registerBundledAttentionAura(opts: RegisterOptions): Disposable {
  const { registry } = opts;
  return registry.register({
    id: attentionAuraPack.id,
    origin: "bundled",
    manifest: {
      id: attentionAuraPack.id,
      type: "ambient-ui",
      version: "0.1.0",
      yorishiroVersion: "^0.1.0",
      entry: "ui.tsx",
    },
    pack: { mount: attentionAuraPack.mount },
  });
}
