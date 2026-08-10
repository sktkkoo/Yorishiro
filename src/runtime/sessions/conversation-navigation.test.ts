// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  type ActiveConversationEntry,
  beginConversationTransition,
  type ConversationNavigationEntry,
  type ConversationNavigationTrail,
  type ConversationTransitionKind,
  canNavigateConversation,
  conversationEntryLaunch,
  conversationNavigationReducer,
  conversationNavigationTarget,
  createConversationTransitionGate,
  currentConversationEntry,
  EMPTY_CONVERSATION_NAVIGATION_TRAIL,
  finishConversationTransition,
  prepareConversationDraftForReplacement,
  prepareFreshConversationRequest,
} from "./conversation-navigation";
import { readConversationSelectionWithin } from "./observed-session";

const session = (id: string): ConversationNavigationEntry => ({ kind: "session", id });
const confirmedTrail = (
  ids: readonly string[],
  cursor = ids.length - 1,
): ConversationNavigationTrail => ({
  entries: ids.map(session),
  cursor,
  transient: null,
});

describe("conversationNavigationReducer", () => {
  it("seeds and advances the persistent trail only from observed confirmed provider sessions", () => {
    const observed = conversationNavigationReducer(EMPTY_CONVERSATION_NAVIGATION_TRAIL, {
      type: "confirmed-session-observed",
      sessionId: "A",
    });
    expect(observed).toEqual(confirmedTrail(["A"]));

    expect(
      conversationNavigationReducer(observed, {
        type: "confirmed-session-observed",
        sessionId: "B",
      }),
    ).toEqual(confirmedTrail(["A", "B"]));
  });

  it("allows an initial blank to be replaced without inventing a confirmed origin", () => {
    const blank = conversationNavigationReducer(EMPTY_CONVERSATION_NAVIGATION_TRAIL, {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    expect(blank).toEqual({
      entries: [],
      cursor: -1,
      transient: { kind: "new-draft", originCursor: -1, lease: "draft-1" },
    });
    expect(canNavigateConversation(blank, "back")).toBe(false);
    expect(canNavigateConversation(blank, "forward")).toBe(false);

    expect(
      conversationNavigationReducer(blank, {
        type: "draft-hydrated",
        draftLease: "draft-1",
        sessionId: "B",
      }),
    ).toEqual(confirmedTrail(["B"]));
  });

  it("uses the backend's atomic outgoing ID to preserve A before committing a fresh draft", () => {
    // New click時のfrontend pollingがnullでも、session_spawn successが返したAを先にseedする。
    const outgoingConfirmed = conversationNavigationReducer(EMPTY_CONVERSATION_NAVIGATION_TRAIL, {
      type: "outgoing-session-confirmed",
      sessionId: "A",
    });
    const blank = conversationNavigationReducer(outgoingConfirmed, {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });

    expect(conversationNavigationTarget(blank, "back")).toEqual(session("A"));
  });

  it("commits a confirmed outgoing draft before a later New replaces it", () => {
    const draftB = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-B",
    });

    expect(
      conversationNavigationReducer(draftB, {
        type: "outgoing-session-confirmed",
        sessionId: "B",
      }),
    ).toEqual(confirmedTrail(["A", "B"]));
  });

  it("keeps New blank outside entries and leaves the confirmed cursor unchanged", () => {
    const atA = confirmedTrail(["A"]);
    const blank = conversationNavigationReducer(atA, {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });

    expect(blank).toEqual({
      entries: [session("A")],
      cursor: 0,
      transient: { kind: "new-draft", originCursor: 0, lease: "draft-1" },
    });
    expect(currentConversationEntry(blank)).toEqual({
      kind: "new-draft",
      originCursor: 0,
      lease: "draft-1",
    });
    const active = currentConversationEntry(blank);
    if (active === null) throw new Error("expected active blank draft");
    expect(conversationEntryLaunch(active)).toEqual({ kind: "fresh" });
  });

  it("A → blank → Back discards blank and leaves Forward disabled", () => {
    const blank = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    expect(conversationNavigationTarget(blank, "back")).toEqual(session("A"));
    expect(conversationNavigationTarget(blank, "forward")).toBeNull();

    const atA = conversationNavigationReducer(blank, {
      type: "navigation-succeeded",
      direction: "back",
      entry: session("A"),
    });
    expect(atA).toEqual(confirmedTrail(["A"]));
    expect(canNavigateConversation(atA, "forward")).toBe(false);
  });

  it("records the provider's actual fork ID when exact Back falls back from an active writer", () => {
    const blank = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    const atFork = conversationNavigationReducer(blank, {
      type: "navigation-succeeded",
      direction: "back",
      entry: session("A"),
      actualSessionId: "fork-A",
    });

    expect(atFork).toEqual(confirmedTrail(["fork-A"]));
    expect(canNavigateConversation(atFork, "forward")).toBe(false);
  });

  it("replaces the rollback entry with the actual provider ID", () => {
    expect(
      conversationNavigationReducer(confirmedTrail(["A", "B"], 1), {
        type: "current-session-replaced",
        expectedSessionId: "B",
        actualSessionId: "fork-B",
      }),
    ).toEqual(confirmedTrail(["A", "fork-B"], 1));
  });

  it("A → blank → Back → New starts another fresh blank without an old resume target", () => {
    const firstBlank = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    const atA = conversationNavigationReducer(firstBlank, {
      type: "navigation-succeeded",
      direction: "back",
      entry: session("A"),
    });
    const secondBlank = conversationNavigationReducer(atA, {
      type: "fresh-session-succeeded",
      draftLease: "draft-2",
    });

    const active = currentConversationEntry(secondBlank);
    if (active === null) throw new Error("expected second blank draft");
    expect(conversationEntryLaunch(active)).toEqual({
      kind: "fresh",
    });
    expect(secondBlank.entries).toEqual([session("A")]);
    expect(secondBlank.transient?.lease).toBe("draft-2");
  });

  it("commits a new entry after the caller observes a provider-confirmed session ID", () => {
    const blank = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    const committed = conversationNavigationReducer(blank, {
      type: "draft-hydrated",
      draftLease: "draft-1",
      sessionId: "B",
    });
    expect(committed).toEqual(confirmedTrail(["A", "B"]));
  });

  it("discards a draft and selects an existing confirmed session after provider-native resume", () => {
    const blank = conversationNavigationReducer(confirmedTrail(["A", "B"], 1), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });

    expect(
      conversationNavigationReducer(blank, {
        type: "draft-hydrated",
        draftLease: "draft-1",
        sessionId: "A",
      }),
    ).toEqual(confirmedTrail(["A", "B"], 0));
  });

  it("does not truncate a forward branch until the draft becomes a confirmed session", () => {
    const atB = confirmedTrail(["A", "B", "C"], 1);
    const blank = conversationNavigationReducer(atB, {
      type: "fresh-session-succeeded",
      draftLease: "draft-D",
    });
    expect(blank.entries).toEqual([session("A"), session("B"), session("C")]);
    expect(blank.cursor).toBe(1);
    expect(canNavigateConversation(blank, "forward")).toBe(false);

    const committed = conversationNavigationReducer(blank, {
      type: "draft-hydrated",
      draftLease: "draft-D",
      sessionId: "D",
    });
    expect(committed).toEqual(confirmedTrail(["A", "B", "D"]));
  });

  it("reconciles a provider-confirmed native resume and truncates only for a new branch", () => {
    const atB = confirmedTrail(["A", "B", "C"], 1);
    const resumedA = conversationNavigationReducer(atB, {
      type: "confirmed-session-observed",
      sessionId: "A",
    });
    expect(resumedA).toEqual(confirmedTrail(["A", "B", "C"], 0));

    expect(
      conversationNavigationReducer(resumedA, {
        type: "confirmed-session-observed",
        sessionId: "D",
      }),
    ).toEqual(confirmedTrail(["A", "D"]));
  });

  it("replaces one blank transient with another without appending a history entry", () => {
    const first = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    const second = conversationNavigationReducer(first, {
      type: "fresh-session-succeeded",
      draftLease: "draft-2",
    });

    expect(second.entries).toEqual([session("A")]);
    expect(second.cursor).toBe(0);
    expect(second.transient).toEqual({
      kind: "new-draft",
      originCursor: 0,
      lease: "draft-2",
    });
  });

  it("rejects stale hydration and failure commits without mutating state", () => {
    const blank = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    expect(
      conversationNavigationReducer(blank, {
        type: "draft-hydrated",
        draftLease: "stale-draft",
        sessionId: "B",
      }),
    ).toBe(blank);
    expect(conversationNavigationReducer(blank, { type: "operation-failed" })).toBe(blank);
  });

  it("ignores a late provider ID after Back has discarded the blank draft", () => {
    const blank = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    const atA = conversationNavigationReducer(blank, {
      type: "navigation-succeeded",
      direction: "back",
      entry: session("A"),
    });

    expect(
      conversationNavigationReducer(atA, {
        type: "draft-hydrated",
        draftLease: "draft-1",
        sessionId: "late-B",
      }),
    ).toBe(atA);
  });

  it("ignores a late provider ID from a blank replaced by a newer New", () => {
    const first = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    const second = conversationNavigationReducer(first, {
      type: "fresh-session-succeeded",
      draftLease: "draft-2",
    });

    expect(
      conversationNavigationReducer(second, {
        type: "draft-hydrated",
        draftLease: "draft-1",
        sessionId: "late-B",
      }),
    ).toBe(second);
  });
});

describe("conversation transition gate", () => {
  function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  it.each([
    ["Back", "back"],
    ["Forward", "forward"],
    ["New", "new"],
  ] as const)("blocks repeated %s while its first transition is in flight", async (_, kind) => {
    const gate = createConversationTransitionGate();
    const pending = deferred();
    let launches = 0;
    let commits = 0;

    const attempt = async (attemptKind: ConversationTransitionKind): Promise<boolean> => {
      const lease = beginConversationTransition(gate, attemptKind);
      if (lease === null) return false;
      launches += 1;
      try {
        await pending.promise;
        commits += 1;
      } finally {
        finishConversationTransition(gate, lease);
      }
      return true;
    };

    const first = attempt(kind);
    await expect(attempt(kind)).resolves.toBe(false);
    expect(launches).toBe(1);
    expect(commits).toBe(0);
    pending.resolve();
    await expect(first).resolves.toBe(true);
    expect(launches).toBe(1);
    expect(commits).toBe(1);
  });

  it("blocks heterogeneous Back → New/Forward transitions under the same lease", () => {
    const gate = createConversationTransitionGate();
    const backLease = beginConversationTransition(gate, "back");
    if (backLease === null) throw new Error("expected Back lease");
    expect(beginConversationTransition(gate, "new")).toBeNull();
    expect(beginConversationTransition(gate, "forward")).toBeNull();
    expect(finishConversationTransition(gate, backLease)).toBe(true);
  });

  it("does not let a stale completion clear a newer transition", () => {
    const gate = createConversationTransitionGate();
    const first = beginConversationTransition(gate, "back");
    if (first === null) throw new Error("expected first lease");
    finishConversationTransition(gate, first);
    const second = beginConversationTransition(gate, "new");
    if (second === null) throw new Error("expected second lease");
    expect(finishConversationTransition(gate, first)).toBe(false);
    expect(beginConversationTransition(gate, "forward")).toBeNull();
    expect(finishConversationTransition(gate, second)).toBe(true);
  });

  it("allows one Back exact resume and discards one blank transient", async () => {
    const gate = createConversationTransitionGate();
    const pending = deferred();
    let resumes = 0;
    let trail = conversationNavigationReducer(confirmedTrail(["A"]), {
      type: "fresh-session-succeeded",
      draftLease: "draft-1",
    });
    const back = async (): Promise<void> => {
      const lease = beginConversationTransition(gate, "back");
      if (lease === null) return;
      try {
        const target = conversationNavigationTarget(trail, "back");
        if (target && conversationEntryLaunch(target).kind === "exact-resume") resumes += 1;
        await pending.promise;
        if (target) {
          trail = conversationNavigationReducer(trail, {
            type: "navigation-succeeded",
            direction: "back",
            entry: target,
          });
        }
      } finally {
        finishConversationTransition(gate, lease);
      }
    };

    const first = back();
    const repeated = back();
    pending.resolve();
    await Promise.all([first, repeated]);
    expect(resumes).toBe(1);
    expect(trail).toEqual(confirmedTrail(["A"]));
    expect(canNavigateConversation(trail, "forward")).toBe(false);
  });

  it("allows only one confirmed Forward resume and cursor commit", async () => {
    const gate = createConversationTransitionGate();
    const pending = deferred();
    let resumes = 0;
    let trail = confirmedTrail(["A", "B"], 0);
    const forward = async (): Promise<void> => {
      const lease = beginConversationTransition(gate, "forward");
      if (lease === null) return;
      try {
        const target = conversationNavigationTarget(trail, "forward");
        if (target && conversationEntryLaunch(target).kind === "exact-resume") resumes += 1;
        await pending.promise;
        if (target) {
          trail = conversationNavigationReducer(trail, {
            type: "navigation-succeeded",
            direction: "forward",
            entry: target,
          });
        }
      } finally {
        finishConversationTransition(gate, lease);
      }
    };

    const first = forward();
    const repeated = forward();
    pending.resolve();
    await Promise.all([first, repeated]);
    expect(resumes).toBe(1);
    expect(trail.cursor).toBe(1);
  });

  it("allows only one New fresh spawn and no confirmed trail append", async () => {
    const gate = createConversationTransitionGate();
    const pending = deferred();
    let freshSpawns = 0;
    let trail = confirmedTrail(["A"]);
    const startNew = async (): Promise<void> => {
      const lease = beginConversationTransition(gate, "new");
      if (lease === null) return;
      try {
        freshSpawns += 1;
        await pending.promise;
        trail = conversationNavigationReducer(trail, {
          type: "fresh-session-succeeded",
          draftLease: "draft-1",
        });
      } finally {
        finishConversationTransition(gate, lease);
      }
    };

    const first = startNew();
    const repeated = startNew();
    pending.resolve();
    await Promise.all([first, repeated]);
    expect(freshSpawns).toBe(1);
    expect(trail.entries).toEqual([session("A")]);
    expect(trail.transient?.lease).toBe("draft-1");
  });

  it("spawns New immediately and releases its lease while provider ID stays null for 15s", async () => {
    vi.useFakeTimers();
    try {
      const gate = createConversationTransitionGate();
      let trail = EMPTY_CONVERSATION_NAVIGATION_TRAIL;
      let freshSpawns = 0;
      let providerObservationSettled = false;
      const providerObservation = new Promise<null>((resolve) => {
        setTimeout(() => {
          providerObservationSettled = true;
          resolve(null);
        }, 15_000);
      });
      const boundedClickRead = async (): Promise<void> => {
        await readConversationSelectionWithin(() => providerObservation, 40);
      };

      const startNew = async (draftLease: string): Promise<void> => {
        const lease = beginConversationTransition(gate, "new");
        if (lease === null) throw new Error("expected New lease");
        try {
          const request = await prepareFreshConversationRequest({
            draftLease,
            prepareActiveDraft: boundedClickRead,
            reconcileCachedSelection: () => {},
            getTrail: () => trail,
          });
          expect(request.rollbackLaunch).toEqual(
            draftLease === "draft-1" ? null : { kind: "fresh" },
          );
          freshSpawns += 1;
          trail = conversationNavigationReducer(trail, {
            type: "fresh-session-succeeded",
            draftLease: request.draftLease,
          });
        } finally {
          finishConversationTransition(gate, lease);
        }
      };

      const first = startNew("draft-1");
      await vi.advanceTimersByTimeAsync(40);
      await first;
      expect(providerObservationSettled).toBe(false);
      expect(gate.active).toBeNull();
      expect(freshSpawns).toBe(1);
      expect(canNavigateConversation(trail, "back")).toBe(false);

      const second = startNew("draft-2");
      await vi.advanceTimersByTimeAsync(40);
      await second;
      expect(gate.active).toBeNull();
      expect(freshSpawns).toBe(2);
      expect(trail.transient?.lease).toBe("draft-2");

      await vi.advanceTimersByTimeAsync(15_000);
      await providerObservation;
      expect(providerObservationSettled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves an already-confirmed current ID as New rollback target", async () => {
    const trail = confirmedTrail(["A"]);
    const request = await prepareFreshConversationRequest({
      draftLease: "draft-1",
      prepareActiveDraft: async () => {},
      reconcileCachedSelection: () => {},
      getTrail: () => trail,
    });

    expect(request).toEqual({
      draftLease: "draft-1",
      rollbackLaunch: { kind: "exact-resume", sessionId: "A" },
    });
  });
});

describe("prepareConversationDraftForReplacement", () => {
  const draft = (lease: string): ActiveConversationEntry => ({
    kind: "new-draft",
    originCursor: 0,
    lease,
  });

  it("performs one caller-bounded hydration attempt for a draft", async () => {
    const hydrate = vi.fn<() => Promise<void>>().mockResolvedValue();
    await prepareConversationDraftForReplacement({
      getCurrentEntry: () => draft("draft-1"),
      hydrate,
    });
    expect(hydrate).toHaveBeenCalledOnce();
  });

  it("waits for an input draft to become a confirmed session", async () => {
    let resolve!: () => void;
    const pending = new Promise<void>((done) => {
      resolve = done;
    });
    let current: ActiveConversationEntry = draft("draft-1");
    let settled = false;
    const preparation = prepareConversationDraftForReplacement({
      getCurrentEntry: () => current,
      hydrate: () => pending,
    }).then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    current = session("B");
    resolve();
    await preparation;
  });

  it("does not block replacement when provider session ID remains unconfirmed", async () => {
    await expect(
      prepareConversationDraftForReplacement({
        getCurrentEntry: () => draft("draft-1"),
        hydrate: () => Promise.resolve(null),
      }),
    ).resolves.toBeUndefined();
  });
});
