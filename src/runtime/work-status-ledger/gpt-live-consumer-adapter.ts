import type { Disposable } from "@yorishiro/sdk";
import {
  type WorkStatusConsumerAdapter,
  WorkStatusConsumerConnection,
  type WorkStatusSnapshotDeliveryReason,
} from "./consumer-adapter";
import type {
  WorkStatusContractSource,
  WorkStatusEventV1,
  WorkStatusSnapshotV1,
} from "./consumer-contract";
import type { WorkStatusConsumerCapabilities } from "./snapshot-composer";
import type { WorkStatusLedgerSnapshot } from "./types";
import {
  formatWorkStatusContractEvent,
  formatWorkStatusContractSnapshot,
  nextWorkStatusFreshnessDelay,
} from "./voice-context";

export type GptLiveContextSource = "event" | "resync" | "freshness";

export interface GptLiveWorkStatusConsumerOptions {
  readonly source: WorkStatusContractSource;
  readonly getLedgerSnapshot: () => WorkStatusLedgerSnapshot;
  readonly appendText: (text: string) => Promise<void>;
  readonly onEventObserved?: (event: WorkStatusEventV1) => void;
  readonly onDeliverySucceeded?: (source: GptLiveContextSource) => void;
  readonly onDeliveryFailed?: (source: GptLiveContextSource, error: unknown) => void;
  readonly capabilities?: Partial<WorkStatusConsumerCapabilities>;
}

export interface GptLiveInitialContext {
  readonly item: { readonly role: "developer"; readonly text: string };
}

const DEFAULT_CAPABILITIES: WorkStatusConsumerCapabilities = Object.freeze({
  maxSnapshotBytes: 16 * 1024,
  maxWorks: 20,
  eventPush: true,
  delegation: true,
  plainTextOnly: true,
});

/** GPT Live-specific initialItems/appendText transport over the neutral consumer contract. */
export class GptLiveWorkStatusConsumerAdapter implements WorkStatusConsumerAdapter, Disposable {
  readonly capabilities: WorkStatusConsumerCapabilities;
  private readonly connection: WorkStatusConsumerConnection;
  private freshnessTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  constructor(private readonly options: GptLiveWorkStatusConsumerOptions) {
    this.capabilities = Object.freeze({ ...DEFAULT_CAPABILITIES, ...options.capabilities });
    this.connection = new WorkStatusConsumerConnection(options.source, this);
  }

  prepareInitialContext(): GptLiveInitialContext {
    const snapshot = this.connection.prepareInitialSnapshot();
    return {
      item: { role: "developer", text: formatWorkStatusContractSnapshot(snapshot) },
    };
  }

  /** Called only after realtime start and SDP negotiation accepted the initial item. */
  connect(): void {
    this.connection.connect();
    this.scheduleFreshnessRefresh();
  }

  deliverSnapshot(snapshot: WorkStatusSnapshotV1, _reason: WorkStatusSnapshotDeliveryReason): void {
    this.append(formatWorkStatusContractSnapshot(snapshot), "resync");
    this.scheduleFreshnessRefresh();
  }

  deliverEvent(event: WorkStatusEventV1): void {
    this.options.onEventObserved?.(event);
    this.append(formatWorkStatusContractEvent(event), "event");
    this.scheduleFreshnessRefresh();
  }

  dispose(): void {
    this.connection.dispose();
    if (this.freshnessTimer !== null) {
      globalThis.clearTimeout(this.freshnessTimer);
      this.freshnessTimer = null;
    }
  }

  private append(text: string, source: GptLiveContextSource): void {
    void this.options
      .appendText(text)
      .then(() => this.options.onDeliverySucceeded?.(source))
      .catch((error) => {
        this.options.onDeliveryFailed?.(source, error);
      });
  }

  private scheduleFreshnessRefresh(): void {
    if (this.freshnessTimer !== null) {
      globalThis.clearTimeout(this.freshnessTimer);
      this.freshnessTimer = null;
    }
    const delay = nextWorkStatusFreshnessDelay(this.options.getLedgerSnapshot());
    if (delay === null) return;
    this.freshnessTimer = globalThis.setTimeout(() => {
      this.freshnessTimer = null;
      const snapshot = this.connection.getCurrentSnapshot();
      this.append(formatWorkStatusContractSnapshot(snapshot), "freshness");
      this.scheduleFreshnessRefresh();
    }, delay);
  }
}
