import type { Disposable } from "@yorishiro/sdk";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { MAX_NOTE_LENGTH, MAX_SUMMARY_LENGTH, sanitizeHumanText } from "./sanitize-text";
import type {
  CreateDelegatedWorkInput,
  DelegatedWork,
  WorkObservationPort,
  WorkStatus,
  WorkStatusLedgerEvent,
  WorkStatusLedgerSnapshot,
} from "./types";

/** terminal 状態の work を snapshot に残す上限。超えた分は古い順に破棄する。 */
const MAX_FINISHED_WORK_ITEMS = 20;

/**
 * 内部の基底状態。公開 status の approval-required は
 * 「running + pendingApprovals 非空」から毎回導出する。
 */
type BaseStatus = "created" | "running" | "completed" | "failed" | "cancelled";

const TERMINAL_STATUSES: ReadonlySet<BaseStatus> = new Set(["completed", "failed", "cancelled"]);

interface WorkRecord {
  readonly id: string;
  readonly summary: string;
  readonly sessionId: string | null;
  readonly createdAt: number;
  baseStatus: BaseStatus;
  note: string | null;
  updatedAt: number;
  readonly pendingApprovals: Set<string>;
}

export interface WorkStatusLedgerStoreOptions {
  readonly now?: () => number;
}

/**
 * 委任 work の host-owned 台帳。
 *
 * - 各 work は生成時に採番された不変 ID を持つ
 * - lifecycle は created → running →（approval-required ⇄ running）→ terminal
 *   の一方向で、terminal（completed / failed / cancelled）以後は変更を拒否する
 * - 保持するのは sanitize 済みの summary / note だけで、raw terminal log は
 *   一切入らない。voice 層は snapshot / event をそのまま読み上げに使える
 * - approval の解決は TUI が正本。台帳は保留の事実を写すだけで、承認へ
 *   応答する API は持たない（docs/decisions/codex-realtime-voice.md）
 */
export class WorkStatusLedgerStore implements WorkObservationPort {
  private readonly now: () => number;
  private readonly work = new Map<string, WorkRecord>();
  private readonly snapshotListeners = new Set<(snapshot: WorkStatusLedgerSnapshot) => void>();
  private readonly eventListeners = new Set<(event: WorkStatusLedgerEvent) => void>();
  private nextId = 1;
  private snapshot: WorkStatusLedgerSnapshot = immutableSnapshot([], 0, 0);

  constructor(options: WorkStatusLedgerStoreOptions = {}) {
    this.now = options.now ?? Date.now;
  }

  /** 新しい委任 work を created で登録する。sanitize 後の summary が空なら投げる。 */
  create(input: CreateDelegatedWorkInput): DelegatedWork {
    const summary = sanitizeHumanText(input.summary, MAX_SUMMARY_LENGTH);
    if (summary.length === 0) {
      throw new Error("Delegated work summary must contain human-readable text");
    }
    const now = this.now();
    const record: WorkRecord = {
      id: `work-${this.nextId++}`,
      summary,
      sessionId: input.sessionId ?? null,
      createdAt: now,
      baseStatus: "created",
      note: this.sanitizeNote(input.note),
      updatedAt: now,
      pendingApprovals: new Set(),
    };
    this.work.set(record.id, record);
    this.publish();
    const work = this.toDelegatedWork(record);
    this.emit({ kind: "work-created", workId: work.id, work });
    return work;
  }

  markRunning(workId: string, note?: string): boolean {
    const record = this.work.get(workId);
    if (!record || TERMINAL_STATUSES.has(record.baseStatus)) return false;
    if (record.baseStatus === "running" && note === undefined) return true;
    this.applyChange(record, () => {
      record.baseStatus = "running";
      if (note !== undefined) record.note = this.sanitizeNote(note);
    });
    return true;
  }

  complete(workId: string, note?: string): boolean {
    const record = this.work.get(workId);
    if (!record || record.baseStatus !== "running") return false;
    return this.finish(record, "completed", note);
  }

  fail(workId: string, note?: string): boolean {
    const record = this.work.get(workId);
    if (!record || TERMINAL_STATUSES.has(record.baseStatus)) return false;
    return this.finish(record, "failed", note);
  }

  cancel(workId: string, note?: string): boolean {
    const record = this.work.get(workId);
    if (!record || TERMINAL_STATUSES.has(record.baseStatus)) return false;
    return this.finish(record, "cancelled", note);
  }

  holdApproval(workId: string, approvalKey: string, note?: string): boolean {
    const record = this.work.get(workId);
    if (!record || record.baseStatus !== "running") return false;
    if (record.pendingApprovals.has(approvalKey)) return true;
    this.applyChange(record, () => {
      record.pendingApprovals.add(approvalKey);
      if (note !== undefined) record.note = this.sanitizeNote(note);
    });
    return true;
  }

  releaseApproval(workId: string, approvalKey: string): boolean {
    const record = this.work.get(workId);
    if (!record?.pendingApprovals.has(approvalKey)) return false;
    this.applyChange(record, () => {
      record.pendingApprovals.delete(approvalKey);
    });
    return true;
  }

  get(workId: string): DelegatedWork | null {
    const record = this.work.get(workId);
    return record ? this.toDelegatedWork(record) : null;
  }

  getSnapshot(): WorkStatusLedgerSnapshot {
    return this.snapshot;
  }

  /** 購読開始時に現在の snapshot を即時通知する（repo の store 慣習に合わせる）。 */
  subscribe(listener: (snapshot: WorkStatusLedgerSnapshot) => void): Disposable {
    this.snapshotListeners.add(listener);
    listener(this.snapshot);
    return {
      dispose: () => {
        this.snapshotListeners.delete(listener);
      },
    };
  }

  /** 状態変化 event の購読。過去分の replay はしない。 */
  subscribeEvents(listener: (event: WorkStatusLedgerEvent) => void): Disposable {
    this.eventListeners.add(listener);
    return {
      dispose: () => {
        this.eventListeners.delete(listener);
      },
    };
  }

  private finish(record: WorkRecord, status: BaseStatus, note?: string): boolean {
    this.applyChange(record, () => {
      record.baseStatus = status;
      // terminal になった work の approval 保留は意味を失うので同時に畳む。
      record.pendingApprovals.clear();
      if (note !== undefined) record.note = this.sanitizeNote(note);
    });
    return true;
  }

  /** 変更を適用し、snapshot publish と work-updated event を一箇所で行う。 */
  private applyChange(record: WorkRecord, mutate: () => void): void {
    const previousStatus = this.publicStatus(record);
    mutate();
    record.updatedAt = this.now();
    this.publish();
    const work = this.toDelegatedWork(record);
    this.emit({ kind: "work-updated", workId: work.id, work, previousStatus });
  }

  private publicStatus(record: WorkRecord): WorkStatus {
    if (record.baseStatus === "running" && record.pendingApprovals.size > 0) {
      return "approval-required";
    }
    return record.baseStatus;
  }

  private sanitizeNote(note: string | undefined | null): string | null {
    if (note === undefined || note === null) return null;
    const sanitized = sanitizeHumanText(note, MAX_NOTE_LENGTH);
    return sanitized.length > 0 ? sanitized : null;
  }

  private toDelegatedWork(record: WorkRecord): DelegatedWork {
    return Object.freeze({
      id: record.id,
      summary: record.summary,
      status: this.publicStatus(record),
      note: record.note,
      sessionId: record.sessionId,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      pendingApprovals: Object.freeze([...record.pendingApprovals]),
    });
  }

  private publish(): void {
    this.pruneFinished();
    const work = [...this.work.values()].map((record) => this.toDelegatedWork(record));
    const activeCount = work.filter(
      (item) =>
        item.status !== "completed" && item.status !== "failed" && item.status !== "cancelled",
    ).length;
    this.snapshot = immutableSnapshot(work, activeCount, this.now());
    for (const listener of this.snapshotListeners) {
      listener(this.snapshot);
    }
  }

  /** terminal 状態の work が増え続けないよう、古い順に上限まで間引く。 */
  private pruneFinished(): void {
    const finished = [...this.work.values()].filter((record) =>
      TERMINAL_STATUSES.has(record.baseStatus),
    );
    if (finished.length <= MAX_FINISHED_WORK_ITEMS) return;
    finished.sort((a, b) => a.updatedAt - b.updatedAt);
    for (const record of finished.slice(0, finished.length - MAX_FINISHED_WORK_ITEMS)) {
      this.work.delete(record.id);
    }
  }

  private emit(event: WorkStatusLedgerEvent): void {
    const immutableEvent = Object.freeze(event);
    for (const listener of this.eventListeners) {
      listener(immutableEvent);
    }
  }
}

function immutableSnapshot(
  work: ReadonlyArray<DelegatedWork>,
  activeCount: number,
  updatedAt: number,
): WorkStatusLedgerSnapshot {
  return Object.freeze({ work: Object.freeze([...work]), activeCount, updatedAt });
}

export function createWorkStatusLedgerStore(
  options: WorkStatusLedgerStoreOptions = {},
): WorkStatusLedgerStore {
  return new WorkStatusLedgerStore(options);
}

export function getWorkStatusLedgerStore(): WorkStatusLedgerStore {
  return getOrInit(KEYS.WORK_STATUS_LEDGER_STORE, () => createWorkStatusLedgerStore());
}
