import type { Disposable } from "@charminal/sdk";
import type { AttentionSnapshot, AttentionTarget } from "../../core/attention";

export interface AttentionRuntime {
  setSourceTarget(source: string, target: AttentionTarget | null): void;
  getSnapshot(): AttentionSnapshot;
  subscribe(listener: (snapshot: AttentionSnapshot) => void): Disposable;
}
