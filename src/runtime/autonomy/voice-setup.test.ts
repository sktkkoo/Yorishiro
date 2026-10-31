// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { readAutonomyConfirmationNotice, readAutonomyWorkReviewNotice } from "./voice-setup";

describe("autonomy review notices", () => {
  it("localizes host review notices only when an app language is supplied", () => {
    const data = {
      id: "daily",
      goal: "原文の目的",
      reason: "Original reason",
      summary: "Original evidence",
    };
    const event = new CustomEvent("review", { detail: { ...data, language: "ja" } });
    expect(readAutonomyWorkReviewNotice(event)).toEqual(data);
    expect(readAutonomyWorkReviewNotice(event, "en")).toEqual({ ...data, language: "en" });
    const confirmation = readAutonomyConfirmationNotice(
      new CustomEvent("confirmation", {
        detail: { id: "action", status: "pending", summary: data.summary },
      }),
      "en",
    );
    expect(confirmation).toMatchObject({
      language: "en",
      reason: "The work result needs your review.",
      summary: data.summary,
    });
  });

  it("bounds confirmation data and gives different statuses distinct notice IDs", () => {
    const detail = {
      id: "action-1",
      status: "pending",
      summary: "Review this result",
      approved: true,
    };
    const notice = readAutonomyConfirmationNotice(new CustomEvent("confirmation", { detail }));
    expect(notice).toMatchObject({ kind: "confirmation", id: "confirmation:action-1:pending" });
    expect(notice).not.toHaveProperty("approved");
    expect(
      readAutonomyConfirmationNotice(
        new CustomEvent("confirmation", { detail: { ...detail, summary: "x".repeat(8001) } }),
      ),
    ).toBeNull();
  });

  it("accepts only bounded work-review data", () => {
    const data = {
      id: "review-1",
      goal: "Organize notes",
      reason: "Related notes",
      summary: "Create summary.md",
    };
    expect(readAutonomyWorkReviewNotice(new CustomEvent("review", { detail: data }))).toEqual(data);
    for (const detail of [
      null,
      {},
      { ...data, id: "" },
      { ...data, summary: 1 },
      { ...data, goal: "x".repeat(8001) },
    ]) {
      expect(readAutonomyWorkReviewNotice(new CustomEvent("review", { detail }))).toBeNull();
    }
  });
});
