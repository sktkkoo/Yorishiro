export type RealtimeConnectionStage =
  | "preflight"
  | "bridge-connect"
  | "initialize"
  | "account"
  | "thread-discovery"
  | "microphone"
  | "webrtc-offer"
  | "ice-gathering"
  | "realtime-start"
  | "sdp-application"
  | "peer-connection"
  | "playback";

export type RealtimeFailureCategory =
  | "cancelled"
  | "permission"
  | "authentication"
  | "configuration"
  | "ownership"
  | "timeout"
  | "network"
  | "remote"
  | "unknown";

export type RealtimeDiagnosticCode = `${RealtimeFailureCategory}.${RealtimeConnectionStage}`;

export interface RealtimeDiagnosticRecord {
  readonly attemptId: string;
  readonly timestamp: string;
  readonly stage: RealtimeConnectionStage;
  readonly event: "started" | "negotiated" | "failed" | "remote-error" | "closed";
  readonly category?: RealtimeFailureCategory;
  readonly elapsedMs: number;
  readonly retryDecision: "none" | "scheduled" | "exhausted";
  readonly terminationRequested: boolean;
  readonly peerConnectionState?: string;
  readonly iceConnectionState?: string;
  /** Privacy-safe, finite diagnostic identifier. Never contains a server error message. */
  readonly code?: RealtimeDiagnosticCode;
  readonly appVersion?: string;
}

const STORAGE_KEY = "yorishiro.codex-realtime.diagnostics.v1";
const MAX_RECORDS = 40;

export function createRealtimeAttemptId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `rt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}

export function classifyRealtimeFailure(
  error: unknown,
  stage: RealtimeConnectionStage,
): { readonly category: RealtimeFailureCategory; readonly retryable: boolean } {
  const record =
    typeof error === "object" && error !== null
      ? (error as { name?: unknown; message?: unknown })
      : null;
  const name = typeof record?.name === "string" ? record.name.toLowerCase() : "";
  const message =
    typeof record?.message === "string"
      ? record.message.toLowerCase()
      : String(error).toLowerCase();
  if (name === "startattemptcancellederror" || message.includes("no longer active")) {
    return { category: "cancelled", retryable: false };
  }
  if (
    name === "notallowederror" ||
    name === "securityerror" ||
    message.includes("permission denied") ||
    message.includes("microphone permission")
  ) {
    return { category: "permission", retryable: false };
  }
  if (
    message.includes("sign in") ||
    message.includes("authentication") ||
    message.includes("unauthorized") ||
    message.includes("api key")
  ) {
    return { category: "authentication", retryable: false };
  }
  if (message.includes("multiple top-level") || message.includes("ownership")) {
    return { category: "ownership", retryable: false };
  }
  if (
    message.includes("invalid voice") ||
    message.includes("invalid loaded thread") ||
    message.includes("did not contain sdp") ||
    message.includes("not accept any voice")
  ) {
    return { category: "configuration", retryable: false };
  }
  if (
    message.includes("timed out") ||
    message.includes("not loaded in time") ||
    name === "timeouterror"
  ) {
    return { category: "timeout", retryable: true };
  }
  if (
    message.includes("network") ||
    message.includes("connection closed") ||
    message.includes("connection failed") ||
    message.includes("ice failed")
  ) {
    return { category: "network", retryable: true };
  }
  if (
    message.includes("rate limit") ||
    message.includes("temporarily unavailable") ||
    message.includes("overloaded") ||
    message.includes("internal server error") ||
    /\b(?:429|5\d\d)\b/.test(message)
  ) {
    return { category: "remote", retryable: true };
  }
  if (stage === "realtime-start" || stage === "sdp-application") {
    return { category: "remote", retryable: false };
  }
  return { category: "unknown", retryable: false };
}

export function realtimeDiagnosticCode(
  category: RealtimeFailureCategory,
  stage: RealtimeConnectionStage,
): RealtimeDiagnosticCode {
  return `${category}.${stage}`;
}

export function appendRealtimeDiagnostic(
  record: RealtimeDiagnosticRecord,
  storage: Pick<Storage, "getItem" | "setItem"> | null = safeStorage(),
): void {
  if (!storage) return;
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    const previous = Array.isArray(parsed) ? parsed : [];
    storage.setItem(STORAGE_KEY, JSON.stringify([...previous, record].slice(-MAX_RECORDS)));
  } catch {
    // Diagnostics must never interfere with voice lifecycle.
  }
}

export function readRealtimeDiagnostics(
  storage: Pick<Storage, "getItem"> | null = safeStorage(),
): ReadonlyArray<RealtimeDiagnosticRecord> {
  if (!storage) return [];
  try {
    const parsed: unknown = JSON.parse(storage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as RealtimeDiagnosticRecord[]) : [];
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
