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
