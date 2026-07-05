/**
 * Bundled pomodoro-ui pack の register helper。
 *
 * App.tsx の起動 path から呼び、ambientUiPackRegistry に登録する。
 */

import type { Disposable } from "@yorishiro/sdk";
import pomodoroUiPack from "../../../bundled-packs/ambient-ui/pomodoro-ui/ui";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";

interface RegisterOptions {
  readonly registry: AmbientUiPackRegistry;
}

export function registerBundledPomodoroUi(opts: RegisterOptions): Disposable {
  const { registry } = opts;
  return registry.register({
    id: pomodoroUiPack.id,
    origin: "bundled",
    manifest: {
      id: pomodoroUiPack.id,
      type: "ambient-ui",
      version: "0.1.0",
      yorishiroVersion: "^0.1.0",
      entry: "ui.tsx",
    },
    pack: { mount: pomodoroUiPack.mount },
  });
}
