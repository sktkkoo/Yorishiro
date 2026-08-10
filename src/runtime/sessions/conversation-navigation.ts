export type ConversationNavigationDirection = "back" | "forward";
export type ConversationTransitionKind = "new" | ConversationNavigationDirection;

export interface ConversationTransitionLease {
  readonly id: number;
  readonly kind: ConversationTransitionKind;
}

/**
 * New / Back / Forward が共有する排他 gate。React の disabled 更新より先に handler 側で
 * lease を確保し、古い operation の finally が新しい operation を解除しないよう id も照合する。
 */
export interface ConversationTransitionGate {
  active: ConversationTransitionLease | null;
  nextId: number;
}

export function createConversationTransitionGate(): ConversationTransitionGate {
  return { active: null, nextId: 1 };
}

export function beginConversationTransition(
  gate: ConversationTransitionGate,
  kind: ConversationTransitionKind,
): ConversationTransitionLease | null {
  if (gate.active !== null) return null;
  const lease = { id: gate.nextId, kind };
  gate.nextId += 1;
  gate.active = lease;
  return lease;
}

export function finishConversationTransition(
  gate: ConversationTransitionGate,
  lease: ConversationTransitionLease,
): boolean {
  if (gate.active?.id !== lease.id || gate.active.kind !== lease.kind) return false;
  gate.active = null;
  return true;
}

export function isConversationTransitionActive(gate: ConversationTransitionGate): boolean {
  return gate.active !== null;
}

/** 永続的な navigation trail に入れてよい、provider ID 確定済みの会話。 */
export interface ConversationNavigationEntry {
  readonly kind: "session";
  readonly id: string;
}

/**
 * New 成功後から最初の入力で provider session ID が確定するまでだけ存在する状態。
 * trail entry ではなく、originCursor 上に一時的に重なる。
 */
export interface NewConversationDraft {
  readonly kind: "new-draft";
  readonly originCursor: number;
  readonly lease: string;
}

export type ActiveConversationEntry = ConversationNavigationEntry | NewConversationDraft;

export interface PrepareConversationDraftOptions {
  readonly getCurrentEntry: () => ActiveConversationEntry | null;
  readonly hydrate: () => Promise<unknown>;
}

/**
 * provider-confirmed ID が既にあれば短いpreflightでhydrateする。
 * raw key/Enterはprovider turn成立の証拠にせず、未確定なら置換を妨げない。
 */
export async function prepareConversationDraftForReplacement(
  options: PrepareConversationDraftOptions,
): Promise<void> {
  const entry = options.getCurrentEntry();
  if (entry?.kind !== "new-draft") return;
  await options.hydrate();
}

export type ConversationEntryLaunch =
  | { readonly kind: "exact-resume"; readonly sessionId: string }
  | { readonly kind: "fresh" };

export interface PreparedFreshConversationRequest {
  readonly draftLease: string;
  readonly rollbackLaunch: ConversationEntryLaunch | null;
}

export interface PrepareFreshConversationRequestOptions {
  readonly draftLease: string;
  readonly prepareActiveDraft: () => Promise<void>;
  readonly reconcileCachedSelection: () => void;
  readonly getTrail: () => ConversationNavigationTrail;
}

/**
 * New click の同期preflight。provider ID の取得は通常時のbackground観測が所有し、
 * ここでは待たない。未観測ならrollbackなしでfresh spawnへ進む。
 */
export async function prepareFreshConversationRequest(
  options: PrepareFreshConversationRequestOptions,
): Promise<PreparedFreshConversationRequest> {
  await options.prepareActiveDraft();
  options.reconcileCachedSelection();
  const current = currentConversationEntry(options.getTrail());
  return {
    draftLease: options.draftLease,
    rollbackLaunch: current === null ? null : conversationEntryLaunch(current),
  };
}

/**
 * confirmed provider sessions だけを持つ線形 trail。New の blank は transient に置き、
 * 初回入力で provider session ID が確定するまで entries / cursor を変えない。
 * scope identity は caller が所有するため、将来 workspace / Main Agent / agent / persona ごとに
 * この state を keying できる。
 */
export interface ConversationNavigationTrail {
  readonly entries: readonly ConversationNavigationEntry[];
  readonly cursor: number;
  readonly transient: NewConversationDraft | null;
}

export type ConversationNavigationAction =
  | {
      readonly type: "fresh-session-succeeded";
      readonly draftLease: string;
    }
  | { readonly type: "confirmed-session-observed"; readonly sessionId: string }
  | {
      readonly type: "current-session-replaced";
      readonly expectedSessionId: string;
      readonly actualSessionId: string;
    }
  | {
      /** PTY replace境界でbackendがatomicに捕捉したoutgoing confirmed session。 */
      readonly type: "outgoing-session-confirmed";
      readonly sessionId: string;
    }
  | {
      readonly type: "navigation-succeeded";
      readonly direction: ConversationNavigationDirection;
      readonly entry: ConversationNavigationEntry;
      /** active-writer fallback等でproviderが実際に選んだID。 */
      readonly actualSessionId?: string;
    }
  | {
      readonly type: "draft-hydrated";
      readonly draftLease: string;
      readonly sessionId: string;
    }
  | { readonly type: "operation-failed" }
  | { readonly type: "reset" };

export const EMPTY_CONVERSATION_NAVIGATION_TRAIL: ConversationNavigationTrail = Object.freeze({
  entries: Object.freeze([]),
  cursor: -1,
  transient: null,
});

function isNonEmpty(value: string | null): value is string {
  return typeof value === "string" && value.length > 0;
}

export function conversationEntriesEqual(
  left: ActiveConversationEntry,
  right: ActiveConversationEntry,
): boolean {
  if (left.kind === "session") return right.kind === "session" && left.id === right.id;
  return right.kind === "new-draft" && left.lease === right.lease;
}

export function conversationEntryLaunch(entry: ActiveConversationEntry): ConversationEntryLaunch {
  return entry.kind === "session"
    ? { kind: "exact-resume", sessionId: entry.id }
    : { kind: "fresh" };
}

export function currentConversationEntry(
  trail: ConversationNavigationTrail,
): ActiveConversationEntry | null {
  if (trail.transient !== null) return trail.transient;
  if (trail.cursor < 0 || trail.cursor >= trail.entries.length) return null;
  return trail.entries[trail.cursor] ?? null;
}

export function currentConfirmedConversationEntry(
  trail: ConversationNavigationTrail,
): ConversationNavigationEntry | null {
  if (trail.cursor < 0 || trail.cursor >= trail.entries.length) return null;
  return trail.entries[trail.cursor] ?? null;
}

export function conversationNavigationTarget(
  trail: ConversationNavigationTrail,
  direction: ConversationNavigationDirection,
): ConversationNavigationEntry | null {
  if (trail.transient !== null) {
    if (direction === "forward") return null;
    return trail.entries[trail.transient.originCursor] ?? null;
  }
  const targetCursor = trail.cursor + (direction === "back" ? -1 : 1);
  if (targetCursor < 0 || targetCursor >= trail.entries.length) return null;
  const target = trail.entries[targetCursor] ?? null;
  const current = currentConversationEntry(trail);
  return target && current && conversationEntriesEqual(target, current) ? null : target;
}

export function canNavigateConversation(
  trail: ConversationNavigationTrail,
  direction: ConversationNavigationDirection,
): boolean {
  return conversationNavigationTarget(trail, direction) !== null;
}

function commitFreshSession(
  trail: ConversationNavigationTrail,
  draftLease: string,
): ConversationNavigationTrail {
  if (!isNonEmpty(draftLease)) return trail;
  if (trail.transient?.lease === draftLease) return trail;
  return {
    entries: trail.entries,
    cursor: trail.cursor,
    transient: {
      kind: "new-draft",
      originCursor: trail.transient?.originCursor ?? trail.cursor,
      lease: draftLease,
    },
  };
}

function observeConfirmedSession(
  trail: ConversationNavigationTrail,
  sessionId: string,
): ConversationNavigationTrail {
  if (!isNonEmpty(sessionId) || trail.transient !== null) return trail;
  const current = currentConfirmedConversationEntry(trail);
  if (current?.id === sessionId) return trail;
  const existingIndex = trail.entries.findIndex((entry) => entry.id === sessionId);
  if (existingIndex >= 0) {
    return { entries: trail.entries, cursor: existingIndex, transient: null };
  }
  const prefix = trail.cursor >= 0 ? trail.entries.slice(0, trail.cursor + 1) : [];
  const entries = [...prefix, { kind: "session" as const, id: sessionId }];
  return {
    entries,
    cursor: entries.length - 1,
    transient: null,
  };
}

function replaceCurrentConfirmedSession(
  trail: ConversationNavigationTrail,
  expectedSessionId: string,
  actualSessionId: string,
): ConversationNavigationTrail {
  if (!isNonEmpty(expectedSessionId) || !isNonEmpty(actualSessionId)) return trail;
  if (trail.transient !== null) return trail;
  const current = currentConfirmedConversationEntry(trail);
  if (current?.id !== expectedSessionId) return trail;
  if (expectedSessionId === actualSessionId) return trail;
  const entries = trail.entries.map((entry, index) =>
    index === trail.cursor ? { kind: "session" as const, id: actualSessionId } : entry,
  );
  return { entries, cursor: trail.cursor, transient: null };
}

function commitNavigation(
  trail: ConversationNavigationTrail,
  direction: ConversationNavigationDirection,
  entry: ConversationNavigationEntry,
  actualSessionId?: string,
): ConversationNavigationTrail {
  const target = conversationNavigationTarget(trail, direction);
  if (target === null || !conversationEntriesEqual(target, entry)) return trail;
  const actualEntry = {
    kind: "session" as const,
    id: isNonEmpty(actualSessionId ?? null) ? (actualSessionId as string) : entry.id,
  };
  if (trail.transient !== null) {
    if (direction !== "back") return trail;
    const entries = trail.entries.map((confirmed, index) =>
      index === trail.transient?.originCursor ? actualEntry : confirmed,
    );
    return {
      entries,
      cursor: trail.transient.originCursor,
      transient: null,
    };
  }
  const cursor = trail.cursor + (direction === "back" ? -1 : 1);
  const entries = trail.entries.map((confirmed, index) =>
    index === cursor ? actualEntry : confirmed,
  );
  return {
    entries,
    cursor,
    transient: null,
  };
}

function hydrateDraft(
  trail: ConversationNavigationTrail,
  draftLease: string,
  sessionId: string,
): ConversationNavigationTrail {
  if (!isNonEmpty(draftLease) || !isNonEmpty(sessionId)) return trail;
  if (trail.transient?.lease !== draftLease) return trail;
  const existingIndex = trail.entries.findIndex((entry) => entry.id === sessionId);
  if (existingIndex >= 0) {
    // draft 内の provider-native resume/fork selection は新規 entry にせず、
    // ephemeral draft を破棄して既存の confirmed cursor へ同期する。
    return { entries: trail.entries, cursor: existingIndex, transient: null };
  }
  const prefix = trail.entries.slice(0, trail.transient.originCursor + 1);
  const entries = [...prefix, { kind: "session" as const, id: sessionId }];
  return { entries, cursor: entries.length - 1, transient: null };
}

function confirmOutgoingSession(
  trail: ConversationNavigationTrail,
  sessionId: string,
): ConversationNavigationTrail {
  if (!isNonEmpty(sessionId)) return trail;
  if (trail.transient !== null) {
    return hydrateDraft(trail, trail.transient.lease, sessionId);
  }
  return observeConfirmedSession(trail, sessionId);
}

export function conversationNavigationReducer(
  trail: ConversationNavigationTrail,
  action: ConversationNavigationAction,
): ConversationNavigationTrail {
  switch (action.type) {
    case "fresh-session-succeeded":
      return commitFreshSession(trail, action.draftLease);
    case "confirmed-session-observed":
      return observeConfirmedSession(trail, action.sessionId);
    case "current-session-replaced":
      return replaceCurrentConfirmedSession(
        trail,
        action.expectedSessionId,
        action.actualSessionId,
      );
    case "outgoing-session-confirmed":
      return confirmOutgoingSession(trail, action.sessionId);
    case "navigation-succeeded":
      return commitNavigation(trail, action.direction, action.entry, action.actualSessionId);
    case "draft-hydrated":
      return hydrateDraft(trail, action.draftLease, action.sessionId);
    case "operation-failed":
      return trail;
    case "reset":
      return EMPTY_CONVERSATION_NAVIGATION_TRAIL;
  }
}
