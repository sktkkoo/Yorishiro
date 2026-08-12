/**
 * Hot-reloaded ambient UI の activation reconciliation。
 *
 * `activeAmbientUi` は user の永続 selection、registry の active set は Presence
 * 等の runtime suppression を反映した実効状態であり、同じものではない。
 * active set 全体を config から作り直さず、対象 id だけを現在の selection / disabled /
 * runtime suppression から導出する。registration history や直前の active 結果は
 * suppression とみなさない。
 */

import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import { parseConfig } from "./config";

export interface AmbientUiRegistrationEvent {
  readonly id: string;
  /** 同じ filesystem pack id の registration を置き換えた場合に true。 */
  readonly replaced: boolean;
}

export interface ReconcileAmbientUiRegistrationDeps {
  readonly registry: AmbientUiPackRegistry;
  /** I/O failure を空 config に変換せず reject する reader を渡す。 */
  readonly readConfigText: () => Promise<string>;
  /** Presence closed 等、config とは別の host/runtime suppression。 */
  readonly isRuntimeSuppressed?: (id: string) => boolean;
}

export type AmbientUiRegistrationReconcileResult =
  | { readonly status: "enabled" | "disabled" }
  | { readonly status: "skipped"; readonly reason: string };

function parseCurrentConfig(text: string) {
  if (text.trim() === "") return null;
  try {
    const raw: unknown = JSON.parse(text);
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  } catch {
    return null;
  }
  return parseConfig(text);
}

/**
 * 対象 id だけを、現在の authoritative state から reconcile する。
 * config を読めない / parse できない場合は active set を一切変更しない。
 */
export async function reconcileAmbientUiRegistration(
  event: AmbientUiRegistrationEvent,
  deps: ReconcileAmbientUiRegistrationDeps,
): Promise<AmbientUiRegistrationReconcileResult> {
  let text: string;
  try {
    text = await deps.readConfigText();
  } catch (err) {
    return {
      status: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const config = parseCurrentConfig(text);
  if (config === null) {
    return { status: "skipped", reason: "config is empty or malformed" };
  }

  const selected = config.activeAmbientUi.includes(event.id);
  const disabled = config.disabledPacks.includes(event.id);
  const runtimeSuppressed = deps.isRuntimeSuppressed?.(event.id) === true;
  if (!selected || disabled || runtimeSuppressed) {
    deps.registry.disable(event.id);
    return { status: "disabled" };
  }

  deps.registry.enable(event.id);
  return { status: "enabled" };
}
