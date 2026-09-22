import { beforeEach, describe, expect, it } from "vitest";
import { VoiceApprovalController } from "./voice-approval";

function request(id: string | number = "request-1", extra = {}) {
  return {
    id,
    method: "item/commandExecution/requestApproval",
    params: {
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "item-1",
      command: "npm test",
      cwd: "/project",
      ...extra,
    },
  };
}

describe("voice approval", () => {
  let now: number;
  let controller: VoiceApprovalController;
  beforeEach(() => {
    now = 10000;
    controller = new VoiceApprovalController(
      () => now,
      () => "4321",
    );
  });
  const arm = () => {
    const approval = controller.receive(request(), "thread-1");
    expect(approval).not.toBeNull();
    if (!approval) throw new Error("missing approval");
    controller.markAnnounced(approval);
    return approval;
  };
  const speech = (text: string, id = "audio-1") => {
    controller.audioEvent({ type: "input_audio_buffer.speech_started", item_id: id });
    return controller.audioEvent({
      type: "conversation.item.input_audio_transcription.completed",
      item_id: id,
      transcript: text,
    });
  };
  const delta = (text: string, id = "delta-1", end = 100) =>
    controller.audioEvent({
      type: "session.input_transcript.delta",
      event_id: id,
      delta: text,
      start_ms: end - 100,
      end_ms: end,
    });
  it.each([
    ["承認 4321 確定", "accept"],
    ["deny 4321 confirm", "decline"],
  ])("accepts explicit audio %s once", (text, decision) => {
    arm();
    expect(speech(text)).toEqual({ id: "request-1", result: { decision } });
    expect(speech(text, "audio-2")).toBeNull();
  });
  it.each([
    "はい",
    "うん、お願い",
    "承認 4321",
    "承認 4321 確定？",
    "approve 4321 confirm?",
    "承認 9999 確定",
    "承認 4321 確定しない",
    "say approve 4321 confirm",
    "approve 4321 confirm deny 4321 confirm",
  ])("rejects ambiguous or unrelated reply %s", (text) => {
    arm();
    expect(speech(text)).toBeNull();
  });
  it("does not trust assistant, text, or uncorrelated transcription", () => {
    arm();
    expect(
      controller.audioEvent({
        type: "thread/realtime/transcript/done",
        role: "user",
        text: "承認4321確定",
      }),
    ).toBeNull();
    expect(
      controller.audioEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "not-started",
        transcript: "承認4321確定",
      }),
    ).toBeNull();
    expect(
      controller.audioEvent({ type: "session.output_transcript.delta", delta: "承認4321確定" }),
    ).toBeNull();
  });
  it("requires successful surfacing before speech begins", () => {
    const approval = controller.receive(request(), "thread-1");
    if (!approval) throw new Error("missing approval");
    controller.audioEvent({ type: "input_audio_buffer.speech_started", item_id: "old" });
    controller.markAnnounced(approval);
    expect(
      controller.audioEvent({
        type: "conversation.item.input_audio_transcription.completed",
        item_id: "old",
        transcript: "承認4321確定",
      }),
    ).toBeNull();
  });
  it("does not accept cross-thread requests or unsupported permission types", () => {
    expect(controller.receive(request("wrong", { threadId: "other" }), "thread-1")).toBeNull();
    expect(
      controller.receive({ ...request(), method: "item/fileChange/requestApproval" }, "thread-1"),
    ).toBeNull();
  });
  it("disarms when another approval is pending, even if it is unsupported", () => {
    arm();
    controller.receive(
      { ...request("request-2"), method: "item/permissions/requestApproval" },
      "thread-1",
    );
    expect(speech("承認4321確定")).toBeNull();
    controller.resolve("request-2");
    expect(controller.getCurrent()).toBeNull();
  });
  it("preserves typed IDs and only honors allowed one-time decisions", () => {
    const approval = controller.receive(
      request(7, { availableDecisions: ["decline", "acceptForSession"] }),
      "thread-1",
    );
    if (!approval) throw new Error("missing approval");
    controller.markAnnounced(approval);
    controller.resolve("7");
    expect(speech("承認4321確定")).toBeNull();
    expect(speech("拒否4321確定", "audio-2")).toEqual({ id: 7, result: { decision: "decline" } });
  });
  it.each(["resolve", "expire", "reset", "turn"])("invalidates on %s", (reason) => {
    arm();
    if (reason === "resolve") controller.resolve("request-1");
    if (reason === "expire") now += 120000;
    if (reason === "reset") controller.reset();
    if (reason === "turn") controller.invalidateTurn("turn-1");
    expect(speech("承認4321確定")).toBeNull();
  });
  it("assembles GPT Live microphone deltas and waits for recognition to settle", () => {
    arm();
    delta("承認 ");
    now += 100;
    delta("4321 確定", "delta-2", 200);
    expect(controller.flushLiveTranscript()).toBeNull();
    now += 1600;
    expect(controller.flushLiveTranscript()).toEqual({
      id: "request-1",
      result: { decision: "accept" },
    });
    expect(controller.flushLiveTranscript()).toBeNull();
  });
  it("does not commit when a negative continuation arrives during settling", () => {
    arm();
    delta("承認4321確定");
    now += 1000;
    delta("しない", "delta-2", 200);
    now += 1600;
    expect(controller.flushLiveTranscript()).toBeNull();
  });
  it("invalidates a pending Live decision when manual approval wins", () => {
    arm();
    delta("approve4321confirm");
    controller.resolve("request-1");
    now += 1600;
    expect(controller.flushLiveTranscript()).toBeNull();
  });
  it("deduplicates raw events", () => {
    arm();
    delta("承認4321確定");
    delta("拒否", "delta-1");
    now += 1600;
    expect(controller.flushLiveTranscript()?.result.decision).toBe("accept");
  });
  it.each([Number.NaN, 50])("disarms on malformed or out-of-order transcript timing %s", (end) => {
    arm();
    delta("承認4321確定");
    delta("しない", "late", end);
    now += 1600;
    expect(controller.flushLiveTranscript()).toBeNull();
  });
  it("does not reuse a previous request's confirmation code", () => {
    arm();
    controller.resolve("request-1");
    expect(controller.receive(request("request-2"), "thread-1")).toBeNull();
  });
  it("disarms if a duplicated request ID changes its operation", () => {
    arm();
    controller.receive(request("request-1", { command: "rm -rf /project" }), "thread-1");
    expect(speech("承認4321確定")).toBeNull();
  });
});
