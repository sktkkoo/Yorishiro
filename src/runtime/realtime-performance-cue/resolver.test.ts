import { describe, expect, it } from "vitest";
import {
  createPerformanceCueResolverState,
  finishAssistantTranscript,
  resolveAssistantTranscriptDelta,
} from "./resolver";

describe("resolveAssistantTranscriptDelta", () => {
  it("chunk 境界をまたぐ節を agree cue へ決定論的に解決する", () => {
    const first = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "う",
      phase: "assistant-responding",
    });
    expect(first.cues).toEqual([]);

    const second = resolveAssistantTranscriptDelta(first.state, {
      utteranceId: "utterance-1",
      delta: "ん、そうですね。",
      phase: "assistant-speaking",
    });

    expect(second.cues).toEqual([
      expect.objectContaining({
        utteranceId: "utterance-1",
        atMs: expect.any(Number),
        expression: "relaxed",
        gestureIntent: "agree",
        intensity: "small",
      }),
    ]);
  });

  it("どの文字位置で chunk を分けても同じ cue と state になる", () => {
    const text = "うん、そうですね。ありがとう！";
    const whole = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: text,
      phase: "assistant-speaking",
    });

    for (let splitAt = 1; splitAt < text.length; splitAt += 1) {
      const first = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
        utteranceId: "utterance-1",
        delta: text.slice(0, splitAt),
        phase: "assistant-speaking",
      });
      const second = resolveAssistantTranscriptDelta(first.state, {
        utteranceId: "utterance-1",
        delta: text.slice(splitAt),
        phase: "assistant-speaking",
      });

      expect([...first.cues, ...second.cues]).toEqual(whole.cues);
      expect(second.state).toEqual(whole.state);
    }
  });

  it("意味のある限定語彙がない通常文では cue を出さない", () => {
    const result = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "ファイルを三つ読みました。次へ進みます。",
      phase: "assistant-speaking",
    });

    expect(result.cues).toEqual([]);
  });

  it("transcript done で句点のない末尾を flush する", () => {
    const pending = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "まずは確認します",
      phase: "assistant-responding",
    });
    const result = finishAssistantTranscript(pending.state, {
      utteranceId: "utterance-1",
      phase: "assistant-responding",
    });

    expect(result.state.pendingText).toBe("");
    expect(result.cues).toEqual([
      expect.objectContaining({ expression: "neutral", gestureIntent: "consider" }),
    ]);
  });

  it("複数節の cue は発話内の文字位置に応じた相対時刻を持つ", () => {
    const result = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "うん、そうですね。ありがとう！",
      phase: "assistant-speaking",
    });

    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].atMs).toBeGreaterThan(0);
    expect(result.cues[1].atMs).toBeGreaterThan(0);
    expect(result.cues[1].expression).toBe("happy");
    expect(result.cues[1].gestureIntent).toBe("none");
  });

  it("user speaking / interrupted 中の delta は捨てて resolver を reset する", () => {
    const pending = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "ありが",
      phase: "assistant-speaking",
    });
    const interrupted = resolveAssistantTranscriptDelta(pending.state, {
      utteranceId: "utterance-1",
      delta: "とう。",
      phase: "user-speaking",
    });

    expect(interrupted.cues).toEqual([]);
    expect(interrupted.state).toEqual(createPerformanceCueResolverState());
  });

  it.each([
    "user-speaking",
    "interrupted",
    "disconnected",
  ] as const)("%s では cue を生成しない", (phase) => {
    const result = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "ありがとう。",
      phase,
    });

    expect(result.cues).toEqual([]);
  });

  it("utterance が変わった時は前発話の未確定 text を結合しない", () => {
    const pending = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "ありが",
      phase: "assistant-speaking",
    });
    const next = resolveAssistantTranscriptDelta(pending.state, {
      utteranceId: "utterance-2",
      delta: "とう。",
      phase: "assistant-speaking",
    });

    expect(next.cues).toEqual([]);
    expect(next.state.utteranceId).toBe("utterance-2");
  });

  it("inline gesture tag を制御 protocol として解釈しない", () => {
    const result = resolveAssistantTranscriptDelta(createPerformanceCueResolverState(), {
      utteranceId: "utterance-1",
      delta: "[gesture:nod] 続けます。",
      phase: "assistant-speaking",
    });

    expect(result.cues).toEqual([]);
  });
});
