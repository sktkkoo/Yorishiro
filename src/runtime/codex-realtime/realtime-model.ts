/** モデル名は Codex の観測結果として扱い、公開 Realtime API の一覧から推測しない。 */
export interface RealtimeModelDiagnostic {
  readonly selection: "auto";
  readonly policy: "server-default" | "legacy-compatibility";
  readonly requestedModel: string | null;
  readonly effectiveModel: string | null;
  readonly effectiveModelSource: "not-reported" | "session-event";
  readonly outcome: "unreported" | "reported" | "different-from-request" | "rejected";
  readonly appServerVersion: string | null;
  readonly authMode: "chatgpt" | "apiKey";
  readonly protocol: "v3";
  /** Codex 0.169 には認証方式別の Realtime モデル一覧がない。 */
  readonly namedSelectionAvailable: false;
}

/**
 * 確認済みの 0.169.0 は v3 の既定値に gpt-live-1-codex を使い、
 * experimental_realtime_ws_model を優先する。Auto はその設定を上書きしない。
 * 古い版・版不明では既存の回避策を維持する。この値は互換性のための
 * リクエストであり、実際に使われたモデルだとは断定しない。
 */
export function automaticRealtimeModel(
  version: string | null,
  authMode: RealtimeModelDiagnostic["authMode"],
): RealtimeModelDiagnostic {
  const match = version?.match(/^(\d+)\.(\d+)\.(\d+)$/);
  const serverDefault =
    match !== undefined && match !== null && (Number(match[1]) > 0 || Number(match[2]) >= 169);
  return {
    selection: "auto",
    policy: serverDefault ? "server-default" : "legacy-compatibility",
    requestedModel: serverDefault ? null : "gpt-live-1-codex",
    effectiveModel: null,
    effectiveModelSource: "not-reported",
    outcome: "unreported",
    appServerVersion: match ? version : null,
    authMode,
    protocol: "v3",
    namedSelectionAvailable: false,
  };
}

/** RPC の受理や SDP 応答だけでは、接続で使われたモデルを特定できない。 */
export function observeRealtimeModel(
  diagnostic: RealtimeModelDiagnostic,
  event: unknown,
): RealtimeModelDiagnostic | null {
  if (typeof event !== "object" || event === null) return null;
  const value = event as { type?: unknown; session?: { model?: unknown } | null };
  if (value.type !== "session.created" && value.type !== "session.updated") return null;
  const model = value.session?.model;
  // モデル識別子だけを残し、セッションの指示や発話内容は保存しない。
  if (typeof model !== "string" || !/^[a-zA-Z0-9_.:/-]{1,128}$/.test(model)) return null;
  return {
    ...diagnostic,
    effectiveModel: model,
    effectiveModelSource: "session-event",
    outcome:
      diagnostic.requestedModel !== null && diagnostic.requestedModel !== model
        ? "different-from-request"
        : "reported",
  };
}

export function isRealtimeModelRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : "";
  return (
    /\bmodel\b/i.test(message) &&
    /invalid|unknown|unsupported|not supported|not found|not available|not allowed|does not exist|rejected/i.test(
      message,
    )
  );
}
