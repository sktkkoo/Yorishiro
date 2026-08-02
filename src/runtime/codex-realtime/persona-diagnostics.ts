import type { CodexRealtimePersonaApplication } from "./codex-realtime-client";

export interface CodexRealtimePersonaDiagnosticRecord
  extends Omit<CodexRealtimePersonaApplication, "delivery" | "startupContextIncluded"> {
  readonly timestamp: string;
  /** True only when a developer item was included in the accepted start request. */
  readonly initialItemsSent: boolean;
  /** This callback runs only after the Realtime session reached active. */
  readonly sessionActive: true;
  readonly delivery: "initial-items" | "prompt-replacement" | "none";
  readonly startupContextIncluded: boolean | null;
}

export const CODEX_REALTIME_PERSONA_DIAGNOSTICS_KEY =
  "yorishiro.codex-realtime.persona-diagnostics.v1";
const MAX_RECORDS = 12;

export function appendCodexRealtimePersonaDiagnostic(
  application: CodexRealtimePersonaApplication,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
  now: () => Date = () => new Date(),
): void {
  if (!storage) return;
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(CODEX_REALTIME_PERSONA_DIAGNOSTICS_KEY) ?? "[]",
    );
    const previous = Array.isArray(parsed) ? parsed : [];
    const record: CodexRealtimePersonaDiagnosticRecord = {
      timestamp: now().toISOString(),
      personaId: application.personaId,
      status: application.status,
      appServerVersion: application.appServerVersion,
      initialItemsSent:
        application.status === "applied" && application.delivery === "initial-items",
      sessionActive: true,
      delivery: application.delivery ?? "none",
      startupContextIncluded: application.startupContextIncluded ?? null,
    };
    storage.setItem(
      CODEX_REALTIME_PERSONA_DIAGNOSTICS_KEY,
      JSON.stringify([...previous, record].slice(-MAX_RECORDS)),
    );
  } catch {
    // Diagnostics must never interfere with GPT Live lifecycle.
  }
}

export function readCodexRealtimePersonaDiagnostics(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): ReadonlyArray<CodexRealtimePersonaDiagnosticRecord> {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(
      storage.getItem(CODEX_REALTIME_PERSONA_DIAGNOSTICS_KEY) ?? "[]",
    );
    return Array.isArray(parsed) ? (parsed as CodexRealtimePersonaDiagnosticRecord[]) : [];
  } catch {
    return [];
  }
}

function safeStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}
