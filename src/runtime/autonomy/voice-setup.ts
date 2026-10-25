export const AUTONOMY_VOICE_SETUP_REQUEST = "yorishiro:autonomy-voice-setup-requested";
export const AUTONOMY_VOICE_SETUP_STATUS = "yorishiro:autonomy-voice-setup-status";
export const AUTONOMY_WORK_REVIEW_AVAILABLE = "yorishiro:autonomy-work-review-available";
export const AUTONOMY_CONFIRMATION_AVAILABLE = "yorishiro:autonomy-confirmation-available";

export interface AutonomyWorkReviewNotice {
  readonly kind?: "confirmation";
  readonly id: string;
  readonly goal: string;
  readonly reason: string;
  readonly summary: string;
}

/** Notification data only: this event cannot approve an external operation. */
export function readAutonomyConfirmationNotice(event: Event): AutonomyWorkReviewNotice | null {
  const value: unknown = (event as CustomEvent<unknown>).detail;
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.id !== "string" ||
    !data.id ||
    data.id.length > 128 ||
    typeof data.status !== "string" ||
    data.status.length > 40 ||
    typeof data.summary !== "string" ||
    data.summary.length > 8_000
  )
    return null;
  return {
    kind: "confirmation",
    id: `confirmation:${data.id}:${data.status}`,
    goal: data.summary,
    reason: "作業結果についてユーザーの確認が必要です。",
    summary: data.summary,
  };
}

export function readAutonomyWorkReviewNotice(event: Event): AutonomyWorkReviewNotice | null {
  const value: unknown = (event as CustomEvent<unknown>).detail;
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  for (const key of ["id", "goal", "reason", "summary"] as const) {
    if (typeof data[key] !== "string" || data[key].length > (key === "id" ? 128 : 8_000))
      return null;
  }
  if (!data.id) return null;
  return {
    id: data.id,
    goal: data.goal,
    reason: data.reason,
    summary: data.summary,
  } as AutonomyWorkReviewNotice;
}

export interface AutonomyVoiceSetupStatus {
  readonly requestId: string;
  readonly phase: "starting" | "active" | "error";
  readonly message: string;
}

/** Host UI request/feedback only. Neither event can grant a background-work scope. */
export function installAutonomyVoiceSetupBridge(request: () => Promise<void>): () => void {
  let disposed = false;
  let pending: string | null = null;
  const publish = (
    requestId: string,
    phase: AutonomyVoiceSetupStatus["phase"],
    message: string,
  ) => {
    window.dispatchEvent(
      new CustomEvent<AutonomyVoiceSetupStatus>(AUTONOMY_VOICE_SETUP_STATUS, {
        detail: { requestId, phase, message },
      }),
    );
  };
  const receive = (event: Event) => {
    const requestId = (event as CustomEvent<{ requestId?: unknown }>).detail?.requestId;
    if (typeof requestId !== "string" || !requestId || requestId.length > 128) return;
    if (pending !== null) {
      publish(requestId, "error", "音声の相談を準備しています。少しお待ちください。");
      return;
    }
    pending = requestId;
    publish(requestId, "starting", "音声で相談する準備をしています…");
    void Promise.resolve()
      .then(() => {
        if (disposed) return;
        return request();
      })
      .then(() => {
        if (!disposed) {
          publish(
            requestId,
            "active",
            "音声で相談できます。話し合った内容は設定案に反映されます。",
          );
        }
      })
      .catch((error: unknown) => {
        if (!disposed) {
          publish(requestId, "error", error instanceof Error ? error.message : String(error));
        }
      })
      .finally(() => {
        if (pending === requestId) pending = null;
      });
  };
  window.addEventListener(AUTONOMY_VOICE_SETUP_REQUEST, receive);
  return () => {
    disposed = true;
    window.removeEventListener(AUTONOMY_VOICE_SETUP_REQUEST, receive);
    if (pending !== null) {
      publish(pending, "error", "音声会話が切り替わりました。もう一度お試しください。");
    }
  };
}
