/**
 * GPT Live Work Status Ledger のドメイン型。
 *
 * 委任 work の台帳を protocol から独立して表現する。Codex app-server の
 * message 形式・thread ID・raw terminal log はここに持ち込まない。protocol
 * 側の観測は adapter が work ID へ解決してから {@link WorkObservationPort}
 * 経由で反映する。
 */

/**
 * 委任 work の lifecycle 状態。
 *
 * approval-required は独立の基底状態ではなく、「running かつ未解決 approval
 * が 1 件以上ある」ことから導出される overlay。approval の解決自体は TUI が
 * 正本であり、台帳は保留の事実だけを写す。
 */
export type WorkStatus =
  | "created"
  | "running"
  | "approval-required"
  | "completed"
  | "failed"
  | "cancelled";

/** 台帳が publish する work の読み取り専用 snapshot。 */
export interface DelegatedWork {
  /** 生成時に採番され、lifecycle を通じて不変な ID。 */
  readonly id: string;
  /** 人間可読の要約。sanitize 済みの短文で、raw log は保持しない。 */
  readonly summary: string;
  readonly status: WorkStatus;
  /** 最新の状態変化を説明する短い注記（無ければ null）。 */
  readonly note: string | null;
  /** work を実行している session（不明なら null）。 */
  readonly sessionId: string | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 未解決 approval の識別 key。空でなければ status は approval-required。 */
  readonly pendingApprovals: ReadonlyArray<string>;
}

/** voice 層がそのまま読める台帳全体の snapshot。 */
export interface WorkStatusLedgerSnapshot {
  /** 作成順の全 work。terminal 状態の work は保持上限を超えると古い順に落ちる。 */
  readonly work: ReadonlyArray<DelegatedWork>;
  /** terminal 状態（completed / failed / cancelled）でない work の数。 */
  readonly activeCount: number;
  readonly updatedAt: number;
}

/** snapshot の差分を追わずに変化を購読するための event。 */
export type WorkStatusLedgerEvent =
  | { readonly kind: "work-created"; readonly workId: string; readonly work: DelegatedWork }
  | {
      readonly kind: "work-updated";
      readonly workId: string;
      readonly work: DelegatedWork;
      readonly previousStatus: WorkStatus;
    };

/** 新しい委任作業の入力。summary は必須で、sanitize 後に空なら拒否される。 */
export interface CreateDelegatedWorkInput {
  readonly summary: string;
  readonly sessionId?: string;
  readonly note?: string;
}

/**
 * Protocol adapter へ渡す最小の観測 port。
 *
 * adapter には台帳の全書き込み API ではなくこの 3 操作だけを見せる。
 * work の作成・完了・失敗・取消の判断は host / voice 層に残す。
 */
export interface WorkObservationPort {
  /** created の work を running へ進める。running なら no-op で true。 */
  markRunning(workId: string, note?: string): boolean;
  /** 未解決 approval を積む。running でない work には積めない。 */
  holdApproval(workId: string, approvalKey: string, note?: string): boolean;
  /** 積んだ approval を下ろす。key が無ければ false。 */
  releaseApproval(workId: string, approvalKey: string): boolean;
}

/**
 * Definitive turn lifecycle events を扱う Codex adapter 向けの mutation port。
 * protocol 型そのものは持ち込まず、domain operation だけを公開する。
 */
export interface WorkLifecyclePort extends WorkObservationPort {
  create(input: CreateDelegatedWorkInput): DelegatedWork;
  complete(workId: string, note?: string): boolean;
  fail(workId: string, note?: string): boolean;
  cancel(workId: string, note?: string): boolean;
}
