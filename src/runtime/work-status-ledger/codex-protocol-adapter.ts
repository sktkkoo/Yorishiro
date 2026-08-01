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
  resolved: boolean;
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

  constructor(ledger: WorkLifecyclePort, sessionId: string) {
    this.ledger = ledger;
    this.sessionId = sessionId;
  }

  setRootThreadId(threadId: string): void {
    this.rootThreadId = threadId;
    this.turnToWork.clear();
    this.threadToWork.clear();
    this.approvals.clear();
  }

  observeServerRequest(request: JsonRpcServerRequest): void {
    if (!isApprovalMethod(request.method) || !isRecord(request.params)) return;
    const { threadId, turnId } = request.params;
    if (typeof threadId !== "string" || typeof turnId !== "string") return;
    if (!this.isObservedThread(threadId)) return;

    const key = approvalKey(request.id);
    if (this.approvals.has(key)) return;
    const approval: PendingApproval = { key, turnId, resolved: false };
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
      case "turn/completed":
        this.observeTurnCompleted(params);
        break;
      case "serverRequest/resolved":
        this.observeApprovalResolved(params);
        break;
    }
  }

  private observeTurnStarted(params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    const turn = recordValue(params.turn);
    const turnId = stringValue(turn?.id);
    if (!threadId || !turnId || !this.isObservedThread(threadId)) return;

    const inheritedWork = threadId === this.rootThreadId ? null : this.threadToWork.get(threadId);
    if (inheritedWork) {
      this.associateTurn(turnId, inheritedWork);
      this.ledger.markRunning(inheritedWork);
      return;
    }
    if (threadId !== this.rootThreadId || this.turnToWork.has(turnId)) return;
    const summary = summaryFromItems(turn?.items);
    if (!summary) return;
    this.createRootWork(turnId, summary);
  }

  private observeItem(params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    const turnId = stringValue(params.turnId);
    const item = recordValue(params.item);
    if (!threadId || !turnId || !item || !this.isObservedThread(threadId)) return;

    let workId = this.workFor(turnId, threadId);
    if (!workId && threadId === this.rootThreadId && item.type === "userMessage") {
      const summary = summaryFromUserMessage(item);
      if (summary) workId = this.createRootWork(turnId, summary);
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

  private observeTurnCompleted(params: Record<string, unknown>): void {
    const threadId = stringValue(params.threadId);
    const turn = recordValue(params.turn);
    const turnId = stringValue(turn?.id);
    if (!threadId || !turnId || threadId !== this.rootThreadId) return;
    const workId = this.turnToWork.get(turnId);
    if (!workId) return;

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
    for (const approval of this.approvals.values()) {
      if (!approval.resolved && approval.turnId === turnId) {
        this.ledger.holdApproval(workId, approval.key, "Waiting for approval in the TUI.");
      }
    }
  }

  private workFor(turnId: string, threadId: string): string | null {
    return this.turnToWork.get(turnId) ?? this.threadToWork.get(threadId) ?? null;
  }

  private isObservedThread(threadId: string): boolean {
    return threadId === this.rootThreadId || this.threadToWork.has(threadId);
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
