// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AUTONOMY_VOICE_SETUP_REQUEST,
  AUTONOMY_VOICE_SETUP_STATUS,
  type AutonomyVoiceSetupStatus,
  installAutonomyVoiceSetupBridge,
  readAutonomyConfirmationNotice,
  readAutonomyWorkReviewNotice,
} from "./voice-setup";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanups.splice(0)) dispose();
});

function setup(request: () => Promise<void>) {
  const statuses: AutonomyVoiceSetupStatus[] = [];
  const receive = (event: Event) =>
    statuses.push((event as CustomEvent<AutonomyVoiceSetupStatus>).detail);
  window.addEventListener(AUTONOMY_VOICE_SETUP_STATUS, receive);
  const dispose = installAutonomyVoiceSetupBridge(request);
  cleanups.push(dispose, () => window.removeEventListener(AUTONOMY_VOICE_SETUP_STATUS, receive));
  const click = (requestId: string) =>
    window.dispatchEvent(new CustomEvent(AUTONOMY_VOICE_SETUP_REQUEST, { detail: { requestId } }));
  return { statuses, dispose, click };
}

describe("autonomy voice setup feedback", () => {
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
  it("acknowledges the UI click and reports success for the same request", async () => {
    const request = vi.fn(async () => {});
    const { statuses, click } = setup(request);
    click("request-1");
    expect(statuses[0]).toMatchObject({ requestId: "request-1", phase: "starting" });
    await vi.waitFor(() =>
      expect(statuses[1]).toMatchObject({ requestId: "request-1", phase: "active" }),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("shows provider/startup failure instead of reporting a ready conversation", async () => {
    const { statuses, click } = setup(async () => {
      throw new Error("Codex voice unavailable");
    });
    click("request-2");
    await vi.waitFor(() =>
      expect(statuses[1]).toMatchObject({ phase: "error", message: "Codex voice unavailable" }),
    );
  });

  it("does not start duplicate voice sessions or publish stale success", async () => {
    let resolve!: () => void;
    const request = vi.fn(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const { statuses, click, dispose } = setup(request);
    click("first");
    click("second");
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    expect(statuses).toContainEqual(
      expect.objectContaining({ requestId: "second", phase: "error" }),
    );
    dispose();
    resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(statuses.filter(({ phase }) => phase === "active")).toEqual([]);
    expect(statuses).toContainEqual(
      expect.objectContaining({ requestId: "first", phase: "error" }),
    );
  });
});
