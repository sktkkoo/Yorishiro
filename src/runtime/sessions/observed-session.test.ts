// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readConversationSelectionWithin,
  waitForConversationSelectionAfterSubmit,
  waitForObservedSessionId,
} from "./observed-session";

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForObservedSessionId", () => {
  it("polls until the initial current session ID becomes observable", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValue("A");

    const observed = waitForObservedSessionId(read, {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    await vi.runAllTimersAsync();

    await expect(observed).resolves.toBe("A");
  });

  it("ignores stale known IDs until a genuinely new session is observed", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("B")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce("C")
      .mockResolvedValue("D");

    const observed = waitForObservedSessionId(read, {
      excludedSessionIds: new Set(["A", "B", "C"]),
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    await vi.runAllTimersAsync();

    await expect(observed).resolves.toBe("D");
  });

  it("requires an exact ID before confirming back or forward navigation", async () => {
    vi.useFakeTimers();
    const read = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce("C")
      .mockResolvedValueOnce(null)
      .mockResolvedValue("B");

    const observed = waitForObservedSessionId(read, {
      expectedSessionId: "B",
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    });
    await vi.runAllTimersAsync();

    await expect(observed).resolves.toBe("B");
  });

  it("stops observing when the owning terminal generation is replaced", async () => {
    const read = vi.fn<() => Promise<string | null>>().mockResolvedValue("stale");

    await expect(
      waitForObservedSessionId(read, {
        shouldContinue: () => false,
      }),
    ).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
});

describe("readConversationSelectionWithin", () => {
  it("returns after the click-time budget even when provider ID remains null for 15 seconds", async () => {
    vi.useFakeTimers();
    const slowRead = new Promise<null>((resolve) => {
      window.setTimeout(() => resolve(null), 15_000);
    });
    let settled = false;
    const immediate = readConversationSelectionWithin(() => slowRead, 40).then((selection) => {
      settled = true;
      return selection;
    });

    await vi.advanceTimersByTimeAsync(39);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(immediate).resolves.toBeNull();
    expect(settled).toBe(true);
  });
});

describe("waitForConversationSelectionAfterSubmit", () => {
  it("keeps a provider-native new thread provisional when no later prompt was submitted", async () => {
    const provisional = { sessionId: "B", confirmed: false, revision: 2 };

    await expect(
      waitForConversationSelectionAfterSubmit({
        readSelection: async () => provisional,
        baselineRevision: 1,
        modeledSessionId: "A",
        submitSequence: 1,
        getCurrentSubmitSequence: () => 1,
        shouldContinue: () => true,
        provisionalTimeoutMs: 0,
        confirmationTimeoutMs: 0,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual(provisional);
  });

  it("does not lose a prompt coalesced just before the provisional timeout", async () => {
    const provisional = { sessionId: "B", confirmed: false, revision: 2 };
    const confirmed = { sessionId: "B", confirmed: true, revision: 3 };
    const readSelection = vi
      .fn<() => Promise<typeof provisional>>()
      .mockResolvedValueOnce(provisional)
      .mockResolvedValue(confirmed);

    await expect(
      waitForConversationSelectionAfterSubmit({
        readSelection,
        baselineRevision: 1,
        modeledSessionId: "A",
        submitSequence: 1,
        // sequence 2 はobserver coalescing中に届いた最初のprompt submit。
        getCurrentSubmitSequence: () => 2,
        shouldContinue: () => true,
        provisionalTimeoutMs: 0,
        confirmationTimeoutMs: 1_000,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual(confirmed);
    expect(readSelection).toHaveBeenCalledTimes(2);
  });

  it("observes a changed provider ID when an unmanaged PTY respawn reset the proxy revision", async () => {
    const respawned = { sessionId: "B", confirmed: true, revision: 2 };

    await expect(
      waitForConversationSelectionAfterSubmit({
        readSelection: async () => respawned,
        // 前proxyのrevisionは高いが、provider ID差を優先して新processを検出する。
        baselineRevision: 10,
        modeledSessionId: "A",
        submitSequence: 1,
        getCurrentSubmitSequence: () => 1,
        shouldContinue: () => true,
        provisionalTimeoutMs: 0,
        confirmationTimeoutMs: 0,
        pollIntervalMs: 0,
      }),
    ).resolves.toEqual(respawned);
  });

  it("drops a late selection when the owning generation or modeled cursor changed", async () => {
    let active = true;
    const result = waitForConversationSelectionAfterSubmit({
      readSelection: async () => {
        active = false;
        return { sessionId: "B", confirmed: true, revision: 2 };
      },
      baselineRevision: 1,
      modeledSessionId: "A",
      submitSequence: 1,
      getCurrentSubmitSequence: () => 1,
      shouldContinue: () => active,
      provisionalTimeoutMs: 0,
      confirmationTimeoutMs: 0,
      pollIntervalMs: 0,
    });

    await expect(result).resolves.toBeNull();
  });
});
