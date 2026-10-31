/** Host context is separate from the user's native turn input. */
export function autonomyConversationContext(language: "ja" | "en" = "ja"): string {
  return [
    `Host context: the user is talking with you in Yorishiro Auto. Continue in ${language === "en" ? "English" : "Japanese"}. This is not a speech transcript or a grant of permission.`,
    "Help the user decide the result they want and the target folder, then discuss the work and its results in this same conversation. Ask one short question only when needed. Do not turn the conversation into an interval, quota or settings questionnaire. Use the host's defaults and preserve existing choices for execution details.",
    "Read autonomy_setup_context before discussing the current scope and before every revised proposal. Before answering any progress or results question, refresh autonomy_setup_context and ground your answer in its workStatus snapshot; read autonomy_action_context for concrete operations, recorded decisions and execution results. Never invent progress, completion or approval. If the available context does not establish the answer, say what is missing.",
    "For a new or revised delegation, use autonomy_propose to update the shared inactive draft progressively. Pass the current draft.id as baseDraftId; use null only when the context reports no draft. Copy unrelated fields from the latest draft, preserving manual edits and incomplete values. Never invent a folder or expand permission. Leave unknown goal and root empty. Do not create a document to stand in for the app's draft.",
    "If a proposal conflicts, reread the latest context and reconcile changed fields. Never retry the old proposal blindly. Only say the proposal changed after a successful autonomy_propose receipt for that revision. Activation remains the user's explicit app action; do not call save/enable/run on their behalf or treat a spoken answer as authorization.",
    "An inactive draft does not modify a running worker. For follow-up directions, distinguish changing a future delegation from changing the current work. Explain that boundary when relevant and never claim a running worker was changed or stopped without a verified host result. Do not duplicate work already running or repeat queued, completed or uncertain external operations.",
    "Keep enduring permission separate from today's concrete task. Preserve automaticActionApproval unless the user explicitly changes it; do not include workMode or publishPullRequest. The host owns execution routing and approvals. Concrete operations needing confirmation use the app's existing action card. Existing tool permissions always apply.",
    "This context supports ongoing questions and results, not a permanent setup-only mode. If the user clearly requests separate immediate Main Agent work, follow the ordinary conversation and its permissions; clarify only if it would duplicate or conflict with delegated work.",
  ].join(" ");
}

interface TurnRun {
  readonly threadId: string;
  readonly language: "ja" | "en";
  readonly resolve: (text: string) => void;
  readonly reject: (error: Error) => void;
  readonly earlyCompletions: Map<string, Record<string, unknown>>;
  turnId: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  deadline: ReturnType<typeof setTimeout> | null;
}

export interface AutonomyConversationTransportOptions {
  readonly request: (method: string, params: Record<string, unknown>) => Promise<unknown>;
  readonly getThreadId: () => string | null;
  /** Recheck the TUI proxy's selected owner before each mutating send. */
  readonly assertSelectedThread: (threadId: string) => Promise<void>;
  readonly timeoutMs?: number;
}

/** Native user turns only; no microphone, PTY input, or authority overrides. */
export class AutonomyConversationTransport {
  private active: TurnRun | null = null;

  constructor(private readonly options: AutonomyConversationTransportOptions) {}

  send(text: string, language: "ja" | "en" = "ja"): Promise<string> {
    const prompt = text.trim();
    const threadId = this.options.getThreadId();
    if (!threadId || !prompt || prompt.length > 8_000) {
      return Promise.reject(
        new Error(
          language === "en"
            ? "The conversation is not ready or the message is invalid."
            : "会話の接続を確認してから送信してください。",
        ),
      );
    }
    if (this.active) {
      return Promise.reject(
        new Error(
          language === "en" ? "Wait for the current reply." : "返事を待ってから送信してください。",
        ),
      );
    }
    return new Promise<string>((resolve, reject) => {
      const run: TurnRun = {
        threadId,
        language,
        resolve,
        reject,
        turnId: null,
        timer: null,
        deadline: null,
        earlyCompletions: new Map(),
      };
      this.active = run;
      run.deadline = setTimeout(
        () =>
          this.finish(
            run,
            undefined,
            new Error(
              language === "en"
                ? "The reply could not be confirmed. Check the Main Agent conversation before retrying."
                : "返事を確認できませんでした。再送する前にMain Agentの会話を確認してください。",
            ),
          ),
        this.options.timeoutMs ?? 10 * 60_000,
      );
      void this.start(run, prompt).catch((error: unknown) =>
        this.finish(run, undefined, error instanceof Error ? error : new Error(String(error))),
      );
    });
  }

  cancel(): void {
    const run = this.active;
    if (run)
      this.finish(
        run,
        undefined,
        new Error(
          run.language === "en"
            ? "The conversation changed. Check the original conversation for any submitted work."
            : "会話が切り替わりました。送信済みの依頼は元の会話で確認してください。",
        ),
      );
    // A submitted native turn belongs to the Main Agent. Cancelling this UI
    // observer must not interrupt unrelated or already-steered agent work.
  }

  onTurnCompleted(value: unknown): void {
    const run = this.active;
    if (!run || !record(value) || value.threadId !== run.threadId || !record(value.turn)) return;
    const turn = value.turn;
    if (typeof turn.id !== "string") return;
    if (run.turnId === null) {
      if (run.earlyCompletions.size >= 8) {
        const oldest = run.earlyCompletions.keys().next().value;
        if (oldest !== undefined) run.earlyCompletions.delete(oldest);
      }
      run.earlyCompletions.set(turn.id, turn);
    } else if (turn.id === run.turnId) this.acceptTurn(run, turn);
  }

  private current(run: TurnRun): boolean {
    return this.active === run && this.options.getThreadId() === run.threadId;
  }

  private async start(run: TurnRun, prompt: string): Promise<void> {
    await this.options.assertSelectedThread(run.threadId);
    if (!this.current(run)) return;
    await this.options.request("thread/inject_items", {
      threadId: run.threadId,
      items: [
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: autonomyConversationContext(run.language) }],
        },
      ],
    });
    await this.options.assertSelectedThread(run.threadId);
    if (!this.current(run)) return;
    // Verified against Codex CLI 0.166.0 generate-ts --experimental:
    // v2/TurnStartParams, UserInput and TurnStartResponse. Omitted policies,
    // model, cwd and workspace roots preserve the Main thread's authority.
    const result = await this.options.request("turn/start", {
      threadId: run.threadId,
      input: [{ type: "text", text: prompt, text_elements: [] }],
    });
    if (!this.current(run)) return;
    const turn = record(result) && record(result.turn) ? result.turn : null;
    if (!turn || typeof turn.id !== "string" || !turn.id)
      throw new Error("Codex did not return a turn identifier");
    run.turnId = turn.id;
    this.acceptTurn(run, run.earlyCompletions.get(turn.id) ?? turn);
    run.earlyCompletions.clear();
    if (this.current(run)) void this.poll(run);
  }

  private acceptTurn(run: TurnRun, turn: Record<string, unknown>): void {
    if (!this.current(run) || turn.id !== run.turnId) return;
    if (turn.status === "failed" || turn.status === "interrupted") {
      const reason =
        record(turn.error) && typeof turn.error.message === "string"
          ? turn.error.message
          : run.language === "en"
            ? "The reply was interrupted."
            : "返事が中断しました。";
      this.finish(run, undefined, new Error(reason));
    } else if (turn.status === "completed") {
      const reply = assistantReply(turn.items);
      // Completion notifications may omit items; poll full items before
      // calling a successful turn an empty answer.
      if (reply) this.finish(run, reply);
    }
  }

  private async poll(run: TurnRun): Promise<void> {
    if (!this.current(run)) return;
    try {
      const result = await this.options.request("thread/turns/list", {
        threadId: run.threadId,
        limit: 20,
        sortDirection: "desc",
        itemsView: "full",
      });
      if (!this.current(run)) return;
      if (record(result) && Array.isArray(result.data)) {
        for (const turn of result.data) if (record(turn)) this.acceptTurn(run, turn);
      }
    } catch {
      // Events remain authoritative; a transient history-read failure can retry
      // until the overall deadline without resubmitting the user's input.
    }
    if (this.current(run)) run.timer = setTimeout(() => void this.poll(run), 1_000);
  }

  private finish(run: TurnRun, text?: string, error?: Error): void {
    if (this.active !== run) return;
    this.active = null;
    if (run.timer !== null) clearTimeout(run.timer);
    if (run.deadline !== null) clearTimeout(run.deadline);
    run.earlyCompletions.clear();
    if (error) run.reject(error);
    else run.resolve(text ?? "");
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function assistantReply(value: unknown): string {
  if (!Array.isArray(value)) return "";
  const messages = value
    .filter(
      (item): item is Record<string, unknown> =>
        record(item) && item.type === "agentMessage" && typeof item.text === "string",
    )
    .reverse();
  const final =
    messages.find((item) => item.phase === "final_answer") ??
    messages.find((item) => item.phase !== "commentary") ??
    messages[0];
  return typeof final?.text === "string" ? final.text.trim() : "";
}
