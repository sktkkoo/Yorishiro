/**
 * CharmCommandDispatcher barrel + runtime integration adapter.
 *
 * Philosophy: docs/next/charm-command-ux.md
 * SDK surface: src/sdk/context.d.ts の CharmAPI（573）と CharmCommandEvent（reaction.d.ts 120）
 */

export {
  CharmCommandDispatcher,
  type CharmPersonaInfo,
  type CharmRuntimeView,
  type CommandEntry,
  type CommandExecutor,
  type ParsedCommand,
} from "./charm-command";

// ─── Runtime integration ──────────────────────────────────────

import type { LogBridge } from "../../core/log-bridge";
import type { Time } from "../../core/time";
import type { PersonaRegistry } from "../persona-registry";
import type { CharmRuntimeView } from "./charm-command";

/**
 * Wire real primitives into a {@link CharmRuntimeView}.
 * Called once during app bootstrap.
 */
export function createRuntimeView(deps: {
  readonly personaRegistry: PersonaRegistry;
  readonly logBridge: LogBridge;
  readonly time: Time;
  readonly startedAt: number;
}): CharmRuntimeView {
  return {
    personas: () => {
      return deps.personaRegistry.registeredIds().map((id) => {
        const def = deps.personaRegistry.getDefinition(id);
        return { id, name: def?.name ?? id };
      });
    },
    recentLog: (count) => deps.logBridge.tail(count),
    logSize: () => deps.logBridge.size(),
    now: () => deps.time.now(),
    startedAt: deps.startedAt,
  };
}
