export interface ChatTranscriptMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly text: string;
}

export interface ChatTranscript {
  readonly conversationId: string | null;
  readonly messages: ReadonlyArray<ChatTranscriptMessage>;
  readonly working: boolean;
  /** 最新ターンの失敗・中断について、元の端末画面で確認が必要。 */
  readonly needsAttention?: boolean;
}

const EMPTY_TRANSCRIPT: ChatTranscript = {
  conversationId: null,
  messages: [],
  working: false,
};
const MAX_CLAUDE_MESSAGES = 400;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Codex の降順 turn 一覧から、ユーザーと assistant の本文だけを時系列順に取り出す。 */
export function chatTranscriptFromCodexTurns(
  conversationId: string,
  turns: ReadonlyArray<unknown>,
): ChatTranscript {
  const messages: ChatTranscriptMessage[] = [];
  const seenIds = new Set<string>();
  const newestTurn = turns.find((turn) => isRecord(turn) && nonemptyText(turn.id) !== null);
  const needsAttention =
    isRecord(newestTurn) && (newestTurn.status === "failed" || newestTurn.status === "interrupted");
  let working = false;
  for (const turn of [...turns].reverse()) {
    if (!isRecord(turn)) continue;
    const turnId = nonemptyText(turn.id);
    if (!turnId) continue;
    if (turn.status === "inProgress") working = true;
    if (!Array.isArray(turn.items)) continue;
    for (const [index, item] of turn.items.entries()) {
      if (!isRecord(item)) continue;
      let role: ChatTranscriptMessage["role"];
      let text: string | null;
      if (item.type === "userMessage") {
        if (!Array.isArray(item.content)) continue;
        role = "user";
        text = nonemptyText(
          item.content
            .filter((part) => isRecord(part) && part.type === "text")
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join(""),
        );
      } else if (item.type === "agentMessage") {
        role = "assistant";
        text = nonemptyText(item.text);
      } else {
        continue;
      }
      if (!text) continue;
      const id = `${conversationId}:${turnId}:${nonemptyText(item.id) ?? index}`;
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      messages.push({ id, role, text });
    }
  }
  return { conversationId, messages, working, ...(needsAttention ? { needsAttention: true } : {}) };
}

/**
 * 今回のアプリ起動中に観測した Claude の会話。過去ログの読み込みは行わない。
 * host が認証・起動世代を検証した hook 経路からだけ入力する。transcript ファイルは
 * 最終応答の反映が遅れるため、返信は Stop の last_assistant_message から記録する。
 */
export class ClaudeChatTranscriptStore {
  private readonly transcripts = new Map<string, ChatTranscript>();
  private readonly lastSequences = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  read(hostSessionId: string): ChatTranscript {
    return this.transcripts.get(hostSessionId) ?? EMPTY_TRANSCRIPT;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  clear(hostSessionId: string): void {
    // seq の下限は残す。遅延した polling 側のコピーで消去済みの会話を復活させない。
    if (this.transcripts.delete(hostSessionId)) this.notify();
  }

  ingestHook(raw: string): void {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isRecord(value) || value.agent !== "claude") return;
    const hostSessionId = nonemptyText(value.sessionId);
    const conversationId = nonemptyText(value.session_id);
    const seq = value._yorishiro_seq;
    if (
      !hostSessionId ||
      !conversationId ||
      typeof seq !== "number" ||
      !Number.isSafeInteger(seq) ||
      seq < 0 ||
      seq <= (this.lastSequences.get(hostSessionId) ?? -1)
    ) {
      return;
    }
    const event = value.event;
    if (
      event !== "session-start" &&
      event !== "session-end" &&
      event !== "prompt" &&
      event !== "stop" &&
      event !== "stop-failure"
    ) {
      return;
    }
    this.lastSequences.set(hostSessionId, seq);
    const previous = this.read(hostSessionId);
    const current =
      previous.conversationId === conversationId
        ? previous
        : { conversationId, messages: [], working: false };
    const text =
      event === "prompt"
        ? nonemptyText(value.prompt)
        : event === "stop"
          ? nonemptyText(value.last_assistant_message)
          : null;
    const messages = text
      ? [
          ...current.messages,
          {
            id: `${conversationId}:${seq}`,
            role: event === "prompt" ? ("user" as const) : ("assistant" as const),
            text,
          },
        ].slice(-MAX_CLAUDE_MESSAGES)
      : current.messages;
    const working = event === "prompt";
    const needsAttention =
      event === "stop-failure" || (event === "session-end" && current.needsAttention === true);
    if (
      current === previous &&
      messages === current.messages &&
      working === current.working &&
      needsAttention === (current.needsAttention === true)
    )
      return;
    this.transcripts.set(hostSessionId, {
      conversationId,
      messages,
      working,
      ...(needsAttention ? { needsAttention: true } : {}),
    });
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}
