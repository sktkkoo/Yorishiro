import { describe, expect, it } from "vitest";
import type { ContinuityMessage } from "../runtime/continuity/types";
import {
  acknowledgeReplyArrival,
  clearReplyArrivals,
  createReplyArrivals,
  reconcileReplyArrivals,
} from "./continuity-reply-arrivals";

const reply = (id: string): ContinuityMessage => ({
  id,
  role: "assistant",
  source: "conversation",
  content: id,
  createdAt: 1,
  replyKind: "report",
});

describe("continuity reply arrivals", () => {
  it("baselines history and keeps subsequent assistant arrivals in conversation order", () => {
    let state = reconcileReplyArrivals(createReplyArrivals(), [reply("old")], false);
    expect(state.pending).toEqual([]);
    const messages: ContinuityMessage[] = [
      reply("old"),
      { ...reply("user"), role: "user" },
      { ...reply("legacy"), source: "legacy" },
      reply("first"),
      reply("second"),
    ];
    state = reconcileReplyArrivals(state, messages, false);
    expect(state.pending).toEqual(["first", "second"]);
    state = acknowledgeReplyArrival(state, "first");
    state = reconcileReplyArrivals(state, [...messages, reply("third")], false);
    expect(state.pending).toEqual(["second", "third"]);
  });

  it("prunes compacted targets without requeuing acknowledged or retained history", () => {
    let state = reconcileReplyArrivals(createReplyArrivals(), [reply("old")], false);
    state = reconcileReplyArrivals(state, [reply("old"), reply("first"), reply("second")], false);
    state = reconcileReplyArrivals(state, [reply("old"), reply("second")], false);
    expect(state.pending).toEqual(["second"]);
    state = acknowledgeReplyArrival(state, "second");
    state = reconcileReplyArrivals(state, [reply("second")], false);
    expect(state.pending).toEqual([]);
  });

  it("retains bottom-follow and explicit clearing without changing the arrival baseline", () => {
    let state = reconcileReplyArrivals(createReplyArrivals(), [reply("old")], true);
    state = reconcileReplyArrivals(state, [reply("old"), reply("first")], true);
    expect(state.pending).toEqual([]);
    state = reconcileReplyArrivals(state, [reply("old"), reply("first"), reply("second")], false);
    expect(state.pending).toEqual(["second"]);
    state = clearReplyArrivals(state);
    state = reconcileReplyArrivals(state, [reply("old"), reply("first"), reply("second")], false);
    expect(state.pending).toEqual([]);
  });
});
