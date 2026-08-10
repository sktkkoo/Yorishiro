export interface WaitForObservedSessionOptions {
  readonly expectedSessionId?: string;
  readonly excludedSessionIds?: ReadonlySet<string>;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly shouldContinue?: () => boolean;
}

export interface ObservedConversationSelection {
  readonly sessionId: string;
  readonly confirmed: boolean;
  readonly revision: number;
}

export interface WaitForConversationSelectionAfterSubmitOptions {
  readonly readSelection: () => Promise<ObservedConversationSelection | null>;
  readonly baselineRevision: number | null;
  readonly modeledSessionId: string | null;
  readonly submitSequence: number;
  readonly getCurrentSubmitSequence: () => number;
  readonly shouldContinue: () => boolean;
  readonly provisionalTimeoutMs?: number;
  readonly confirmationTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

const delay = (durationMs: number): Promise<void> =>
  new Promise((resolve) => window.setTimeout(resolve, durationMs));

/** click transition向けのbest-effort read。provider応答を待ち続けず必ず期限内に返す。 */
export async function readConversationSelectionWithin(
  readSelection: () => Promise<ObservedConversationSelection | null>,
  timeoutMs = 40,
): Promise<ObservedConversationSelection | null> {
  return Promise.race([readSelection(), delay(timeoutMs).then(() => null)]);
}

/**
 * Codex TUI proxy が選択を確定した response だけを待つ。New では既知 ID を除外し、
 * exact resume では目的 ID と一致するまで待つため、respawn 直後の stale 値を採用しない。
 */
export async function waitForObservedSessionId(
  readSelectedSessionId: () => Promise<string | null>,
  options: WaitForObservedSessionOptions = {},
): Promise<string | null> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (options.shouldContinue?.() === false) return null;
    const sessionId = await readSelectedSessionId();
    if (options.shouldContinue?.() === false) return null;
    const matchesExpected =
      options.expectedSessionId === undefined || sessionId === options.expectedSessionId;
    const isExcluded = sessionId !== null && options.excludedSessionIds?.has(sessionId) === true;
    if (sessionId && matchesExpected && !isExcluded) return sessionId;

    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) return null;
    await delay(Math.min(pollIntervalMs, remainingMs));
  }
}

/**
 * submit 後の provider selection 変化を観測する。native `/new` の provisional
 * thread/start 中に次のpromptがsubmitされた場合は、そのsubmitをcoalescingで失わず、
 * matching turn/start confirmationまで待つ。
 */
export async function waitForConversationSelectionAfterSubmit(
  options: WaitForConversationSelectionAfterSubmitOptions,
): Promise<ObservedConversationSelection | null> {
  let observed: ObservedConversationSelection | null = null;
  await waitForObservedSessionId(
    async () => {
      const selection = await options.readSelection();
      if (selection === null) return null;
      const advanced =
        selection.sessionId !== options.modeledSessionId ||
        (options.baselineRevision !== null && selection.revision > options.baselineRevision);
      if (!advanced) return null;
      observed = selection;
      return selection.confirmed ? selection.sessionId : null;
    },
    {
      timeoutMs: options.provisionalTimeoutMs ?? 2_000,
      pollIntervalMs: options.pollIntervalMs ?? 50,
      shouldContinue: options.shouldContinue,
    },
  );

  let selection = observed as ObservedConversationSelection | null;
  if (
    selection !== null &&
    !selection.confirmed &&
    options.getCurrentSubmitSequence() > options.submitSequence &&
    options.shouldContinue()
  ) {
    const provisionalRevision = selection.revision;
    await waitForObservedSessionId(
      async () => {
        const next = await options.readSelection();
        if (next === null || next.revision <= provisionalRevision) return null;
        observed = next;
        return next.confirmed ? next.sessionId : null;
      },
      {
        timeoutMs: options.confirmationTimeoutMs ?? 15_000,
        pollIntervalMs: options.pollIntervalMs ?? 50,
        shouldContinue: options.shouldContinue,
      },
    );
    selection = observed as ObservedConversationSelection | null;
  }

  return options.shouldContinue() ? selection : null;
}
