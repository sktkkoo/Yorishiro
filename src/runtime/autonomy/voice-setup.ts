export const AUTONOMY_VOICE_SETUP_REQUEST = "yorishiro:autonomy-voice-setup-requested";
export const AUTONOMY_VOICE_SETUP_STATUS = "yorishiro:autonomy-voice-setup-status";
export const AUTONOMY_WORK_REVIEW_AVAILABLE = "yorishiro:autonomy-work-review-available";
export const AUTONOMY_CONFIRMATION_AVAILABLE = "yorishiro:autonomy-confirmation-available";

export interface AutonomyWorkReviewNotice {
  readonly kind?: "confirmation";
  readonly language?: "ja" | "en";
  readonly id: string;
  readonly goal: string;
  readonly reason: string;
  readonly summary: string;
}

/** Notification data only: this event cannot approve an external operation. */
export function readAutonomyConfirmationNotice(
  event: Event,
  language?: "ja" | "en",
): AutonomyWorkReviewNotice | null {
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
    ...(language ? { language } : {}),
    kind: "confirmation",
    id: `confirmation:${data.id}:${data.status}`,
    goal: data.summary,
    reason:
      language === "en"
        ? "The work result needs your review."
        : "作業結果についてユーザーの確認が必要です。",
    summary: data.summary,
  };
}

export function readAutonomyWorkReviewNotice(
  event: Event,
  language?: "ja" | "en",
): AutonomyWorkReviewNotice | null {
  const value: unknown = (event as CustomEvent<unknown>).detail;
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  for (const key of ["id", "goal", "reason", "summary"] as const) {
    if (typeof data[key] !== "string" || data[key].length > (key === "id" ? 128 : 8_000))
      return null;
  }
  if (!data.id) return null;
  return {
    ...(language ? { language } : {}),
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
export function installAutonomyVoiceSetupBridge(
  request: (language?: "ja" | "en") => Promise<void>,
): () => void {
  let disposed = false;
  let pending: string | null = null;
  let pendingLanguage: "ja" | "en" = "ja";
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
    const detail = (event as CustomEvent<{ requestId?: unknown; language?: unknown }>).detail;
    const requestId = detail?.requestId;
    const language =
      detail?.language === "en" || detail?.language === "ja" ? detail.language : undefined;
    const english = language === "en";
    if (typeof requestId !== "string" || !requestId || requestId.length > 128) return;
    if (pending !== null) {
      publish(
        requestId,
        "error",
        english
          ? "Preparing voice setup. Please wait a moment."
          : "音声の相談を準備しています。少しお待ちください。",
      );
      return;
    }
    pending = requestId;
    pendingLanguage = language ?? "ja";
    publish(
      requestId,
      "starting",
      english ? "Preparing voice setup…" : "音声で相談する準備をしています…",
    );
    void Promise.resolve()
      .then(() => {
        if (disposed) return;
        return request(language);
      })
      .then(() => {
        if (!disposed) {
          publish(
            requestId,
            "active",
            english
              ? "Voice setup is ready. Your conversation will update the proposed settings."
              : "音声で相談できます。話し合った内容は設定案に反映されます。",
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
      publish(
        pending,
        "error",
        pendingLanguage === "en"
          ? "The voice conversation changed. Please try again."
          : "音声会話が切り替わりました。もう一度お試しください。",
      );
    }
  };
}
