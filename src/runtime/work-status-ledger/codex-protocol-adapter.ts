import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import type { WorkLifecyclePort } from "./types";

type RequestId = string | number;

interface JsonRpcServerRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params?: unknown;
}

interface PendingApproval {
  readonly key: string;
  readonly turnId: string;
  readonly threadId: string;
  resolved: boolean;
}

export interface WorkStatusReconcileResult {
  readonly matchedTurns: number;
  readonly terminalTurns: number;
  readonly releasedApprovals: number;
}

/**
 * 既存 Codex app-server subscription の event を Work Status Ledger へ投影する。
 * request への応答経路は意図的に持たず、approval ownership は TUI に残す。
 */
export class CodexWorkStatusProtocolAdapter {
  private readonly ledger: WorkLifecyclePort;
  private readonly sessionId: string;
  private rootThreadId: string | null = null;
  private readonly turnToWork = new Map<string, string>();
  private readonly threadToWork = new Map<string, string>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly handoffToWork = new Map<string, string>();
  private readonly pendingRootTurns: string[] = [];
  private readonly pendingRootWorks: string[] = [];
  private activeRootTurnId: string | null = null;

  constructor(ledger: WorkLifecyclePort, sessionId: string) {
    this.ledger = ledger;
    this.sessionId = sessionId;
  }

  setRootThreadId(threadId: string): void {
    if (this.rootThreadId === threadId) return;
    this.rootThreadId = threadId;
    this.turnToWork.clear();
    this.threadToWork.clear();
    this.approvals.clear();
    this.handoffToWork.clear();
    this.pendingRootTurns.length = 0;
    this.pendingRootWorks.length = 0;
    this.activeRootTurnId = null;
  }

  observeServerRequest(request: JsonRpcServerRequest): void {
    if (!isApprovalMethod(request.method) || !isRecord(request.params)) return;
    const { threadId, turnId } = request.params;
    if (typeof threadId !== "string" || typeof turnId !== "string") return;
    if (!this.isObservedThread(threadId)) return;

    const key = approvalKey(request.id);
    if (this.approvals.has(key)) return;
    const approval: PendingApproval = { key, turnId, threadId, resolved: false };
    this.approvals.set(key, approval);
    const workId = this.workFor(turnId, threadId);
    if (workId) this.ledger.holdApproval(workId, key, "Waiting for approval in the TUI.");
  }

  observeNotification(method: unknown, params: unknown): void {
    if (typeof method !== "string" || !isRecord(params)) return;
    switch (method) {
      case "turn/started":
        this.observeTurnStarted(params);
        break;
      case "item/started":
      case "item/completed":
        this.observeItem(params);
        break;
      case "thread/realtime/itemAdded":
        this.observeRealtimeItem(params);
        break;
      case "turn/completed":
        this.observeTurnCompleted(params);
        break;
      case "serverRequest/resolved":
        this.observeApprovalResolved(params);
        break;
    }
  }

  /**
   * voice が切れていた間に取りこぼした definitive な turn 終端と approval 解決を、
   * `thread/read(includeTurns: true)` の保存済み状態から回復する。
   */
  reconcileRootThread(value: unknown): WorkStatusReconcileResult {
    const thread = recordValue(value);
    if (!thread || stringValue(thread.id) !== this.rootThreadId) {
      return { matchedTurns: 0, terminalTurns: 0, releasedApprovals: 0 };
    }

    let matchedTurns = 0;
    let terminalTurns = 0;
    const turns = Array.isArray(thread.turns) ? thread.turns : [];
    for (const value of turns) {
      const turn = recordValue(value);
      if (!turn) continue;
      const turnId = stringValue(turn.id);
      const workId = turnId ? this.turnToWork.get(turnId) : undefined;
      if (!turnId || !workId) continue;
      matchedTurns += 1;
      if (turn.status === "completed") {
        if (this.ledger.complete(workId, "Completed by Codex.")) terminalTurns += 1;
      } else if (turn.status === "failed") {
        if (this.ledger.fail(workId, "Codex reported that the work failed.")) terminalTurns += 1;
      } else if (turn.status === "interrupted") {
        if (this.ledger.cancel(workId, "The Codex turn was interrupted.")) terminalTurns += 1;
      } else if (turn.status === "inProgress") {
        this.ledger.markRunning(workId);
      }
    }

    const releasedApprovals = this.reconcileApprovalsForThread(thread);

    return { matchedTurns, terminalTurns, releasedApprovals };
  }

  /** voice gap 中に解決された可能性がある approval を持つ thread 一覧。 */
  pendingApprovalThreadIds(): readonly string[] {
    return [
      ...new Set(
        [...this.approvals.values()]
          .filter((approval) => !approval.resolved)
          .map((approval) => approval.threadId),
      ),
    ];
  }

  /** child thread の保存済み runtime status から approval 解決を回復する。 */
  reconcileApprovalThread(value: unknown): number {
    const thread = recordValue(value);
    const threadId = stringValue(thread?.id);
    if (!thread || !threadId || !this.isObservedThread(threadId)) return 0;
    return this.reconcileApprovalsForThread(thread);
  }

  private observeTurnStarted(params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    const turn = recordValue(params.turn);
    const turnId = stringValue(turn?.id);
    if (!threadId || !turnId || !this.isObservedThread(threadId)) return;
    if (threadId === this.rootThreadId) this.activeRootTurnId = turnId;

    const inheritedWork = threadId === this.rootThreadId ? null : this.threadToWork.get(threadId);
    if (inheritedWork) {
      this.associateTurn(turnId, inheritedWork);
      this.ledger.markRunning(inheritedWork);
      return;
    }
    if (threadId !== this.rootThreadId || this.turnToWork.has(turnId)) return;
    const summary = summaryFromItems(turn?.items);
    if (summary) {
      this.createRootWork(turnId, summary);
      return;
    }
    this.queueRootTurn(turnId);
  }

  private observeItem(params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const item = recordValue(params.item);
    if (!threadId || !turnId || !item || !this.isObservedThread(threadId)) return;

    let workId = this.workFor(turnId, threadId);
    if (!workId && threadId === this.rootThreadId && item.type === "userMessage") {
      this.queueRootTurn(turnId);
      workId = this.turnToWork.get(turnId) ?? null;
      if (!workId) {
        const summary = summaryFromUserMessage(item);
        if (summary) workId = this.createRootWork(turnId, summary);
      }
    }
    if (!workId) return;

    this.associateTurn(turnId, workId);
    this.ledger.markRunning(workId);
    if (item.type !== "collabAgentToolCall" || !Array.isArray(item.receiverThreadIds)) return;
    for (const receiver of item.receiverThreadIds) {
      if (typeof receiver === "string" && receiver.length > 0) {
        this.threadToWork.set(receiver, workId);
      }
    }
  }

  /**
   * Realtime handoff is the first definitive signal that GPT Live delegated backend work.
   * Codex emits it before or around the empty `turn/started`, so pair the two independently
   * of their delivery order.
   */
  private observeRealtimeItem(params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    const item = recordValue(params.item);
    if (threadId !== this.rootThreadId || item?.type !== "handoff_request") return;

    const handoffId = stringValue(item.handoff_id);
    if (!handoffId || this.handoffToWork.has(handoffId)) return;
    const summary = summaryFromHandoffRequest(item);
    if (!summary) return;

    const activeWorkId = this.activeRootTurnId
      ? this.turnToWork.get(this.activeRootTurnId)
      : undefined;
    if (activeWorkId) {
      this.handoffToWork.set(handoffId, activeWorkId);
      this.ledger.markRunning(activeWorkId);
      return;
    }

    const work = this.ledger.create({ summary, sessionId: this.sessionId });
    this.ledger.markRunning(work.id, "Codex is working on it.");
    this.handoffToWork.set(handoffId, work.id);
    this.pendingRootWorks.push(work.id);
    this.pairPendingRootWork();
  }

  private observeTurnCompleted(params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    const turn = recordValue(params.turn);
    const turnId = stringValue(turn?.id);
    if (!threadId || !turnId || threadId !== this.rootThreadId) return;
    if (this.activeRootTurnId === turnId) this.activeRootTurnId = null;
    const workId = this.turnToWork.get(turnId);
    if (!workId) {
      removeValue(this.pendingRootTurns, turnId);
      return;
    }

    this.ledger.markRunning(workId);
    if (turn?.status === "completed") {
      this.ledger.complete(workId, "Completed by Codex.");
    } else if (turn?.status === "failed") {
      this.ledger.fail(workId, "Codex reported that the work failed.");
    } else if (turn?.status === "interrupted") {
      this.ledger.cancel(workId, "The Codex turn was interrupted.");
    }
  }

  private observeApprovalResolved(params: Record<string, unknown>): void {
    const requestId = params.requestId;
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    const key = approvalKey(requestId);
    const approval = this.approvals.get(key);
    if (!approval || approval.resolved) return;
    approval.resolved = true;
    const threadId = stringValue(params.threadId);
    const workId =
      this.turnToWork.get(approval.turnId) ?? (threadId && this.threadToWork.get(threadId));
    if (workId) this.ledger.releaseApproval(workId, key);
  }

  private createRootWork(turnId: string, summary: string): string {
    const work = this.ledger.create({ summary, sessionId: this.sessionId });
    this.associateTurn(turnId, work.id);
    this.ledger.markRunning(work.id, "Codex is working on it.");
    return work.id;
  }

  private associateTurn(turnId: string, workId: string): void {
    this.turnToWork.set(turnId, workId);
    removeValue(this.pendingRootTurns, turnId);
    removeValue(this.pendingRootWorks, workId);
    for (const approval of this.approvals.values()) {
      if (!approval.resolved && approval.turnId === turnId) {
        this.ledger.holdApproval(workId, approval.key, "Waiting for approval in the TUI.");
      }
    }
  }

  private workFor(turnId: string, threadId: string): string | null {
    return this.turnToWork.get(turnId) ?? this.threadToWork.get(threadId) ?? null;
  }

  private reconcileApprovalsForThread(thread: Record<string, unknown>): number {
    const threadId = stringValue(thread.id);
    if (!threadId) return 0;
    const status = recordValue(thread.status);
    const activeFlags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
    const stillWaiting = status?.type === "active" && activeFlags.includes("waitingOnApproval");
    if (stillWaiting) return 0;

    let released = 0;
    for (const approval of this.approvals.values()) {
      if (approval.resolved || approval.threadId !== threadId) continue;
      const workId = this.workFor(approval.turnId, threadId);
      if (!workId) continue;
      approval.resolved = true;
      if (this.ledger.releaseApproval(workId, approval.key)) released += 1;
    }
    return released;
  }

  private isObservedThread(threadId: string): boolean {
    return threadId === this.rootThreadId || this.threadToWork.has(threadId);
  }

  private queueRootTurn(turnId: string): void {
    if (!this.turnToWork.has(turnId) && !this.pendingRootTurns.includes(turnId)) {
      this.pendingRootTurns.push(turnId);
    }
    this.pairPendingRootWork();
  }

  private pairPendingRootWork(): void {
    while (this.pendingRootTurns.length > 0 && this.pendingRootWorks.length > 0) {
      const turnId = this.pendingRootTurns.shift();
      const workId = this.pendingRootWorks.shift();
      if (turnId && workId) this.associateTurn(turnId, workId);
    }
  }
}

type AdapterRegistry = WeakMap<WorkLifecyclePort, Map<string, CodexWorkStatusProtocolAdapter>>;

/** 同じ ledger/session/thread の adapter を voice reconnect と HMR を跨いで再利用する。 */
export function getCodexWorkStatusProtocolAdapter(
  ledger: WorkLifecyclePort,
  sessionId: string,
  rootThreadId: string,
): CodexWorkStatusProtocolAdapter {
  const registry = getOrInit<AdapterRegistry>(KEYS.WORK_STATUS_CODEX_ADAPTERS, () => new WeakMap());
  let byThread = registry.get(ledger);
  if (!byThread) {
    byThread = new Map();
    registry.set(ledger, byThread);
  }
  const key = `${sessionId}\u0000${rootThreadId}`;
  let adapter = byThread.get(key);
  if (!adapter) {
    adapter = new CodexWorkStatusProtocolAdapter(ledger, sessionId);
    adapter.setRootThreadId(rootThreadId);
    byThread.set(key, adapter);
  }
  return adapter;
}

function isApprovalMethod(method: string): boolean {
  return (
    method === "item/commandExecution/requestApproval" ||
    method === "item/fileChange/requestApproval" ||
    method === "item/permissions/requestApproval"
  );
}

function approvalKey(id: RequestId): string {
  return `${typeof id}:${String(id)}`;
}

function summaryFromItems(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (const item of value) {
    if (isRecord(item) && item.type === "userMessage") {
      const summary = summaryFromUserMessage(item);
      if (summary) return summary;
    }
  }
  return null;
}

function summaryFromUserMessage(item: Record<string, unknown>): string | null {
  if (!Array.isArray(item.content)) return null;
  const text = item.content
    .filter((part): part is Record<string, unknown> => isRecord(part) && part.type === "text")
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join(" ");
  return text.length > 0 ? text : null;
}

function summaryFromHandoffRequest(item: Record<string, unknown>): string | null {
  const inputTranscript = stringValue(item.input_transcript);
  if (inputTranscript) return inputTranscript;
  if (!Array.isArray(item.active_transcript)) return null;
  for (let index = item.active_transcript.length - 1; index >= 0; index--) {
    const entry = recordValue(item.active_transcript[index]);
    if (entry?.role !== "user") continue;
    const text = stringValue(entry.text);
    if (text) return text;
  }
  return null;
}

function removeValue(values: string[], value: string): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
