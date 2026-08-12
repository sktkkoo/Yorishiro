import { describe, expect, it } from "vitest";
import {
  DefaultAttentionCueLight,
  AttentionCueLight as RuntimeAttentionCueLight,
  useClaimAttentionCue as useRuntimeClaimAttentionCue,
} from "../runtime/three-runtime/attention-cue-light";
import * as AttentionCueSdk from "./attention-cue";

describe("@yorishiro/sdk/attention-cue", () => {
  it("reuses the host runtime component and claim hook", () => {
    expect(AttentionCueSdk.AttentionCueLight).toBe(RuntimeAttentionCueLight);
    expect(AttentionCueSdk.useClaimAttentionCue).toBe(useRuntimeClaimAttentionCue);
  });

  it("does not expose the runtime-owned default component", () => {
    expect(Object.values(AttentionCueSdk)).not.toContain(DefaultAttentionCueLight);
    expect(Object.keys(AttentionCueSdk).sort()).toEqual([
      "AttentionCueLight",
      "useClaimAttentionCue",
    ]);
  });
});
