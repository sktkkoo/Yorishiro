import { describe, expect, it } from "vitest";
import {
  createStateExpressionResolverState,
  finishAssistantTranscript,
  resolveAssistantTranscriptDelta,
} from "./resolver";

describe("resolveAssistantTranscriptDelta", () => {
  it.each([
    ["やった！", "celebrate", "appreciative"],
    ["ついにテストが成功しました！", "celebrate", "appreciative"],
    ["大成功です。", "celebrate", "appreciative"],
    ["成功しましたね。", "celebrate", "appreciative"],
    ["本当に嬉しいです！", "celebrate", "appreciative"],
    ["We did it!", "celebrate", "appreciative"],
    ["I'm thrilled!", "celebrate", "appreciative"],
    ["とても悲しいです。", "sad", "concerned"],
    ["それは悲しいですね。", "sad", "concerned"],
    ["残念です。", "sad", "concerned"],
    ["がっかりしました。", "sad", "concerned"],
    ["落ち込んでいます。", "sad", "concerned"],
    ["I'm disappointed.", "sad", "concerned"],
    ["まだ分かりません。", "uncertain", "considering"],
    ["確信がありません。", "uncertain", "considering"],
    ["現時点では判断できません。", "uncertain", "considering"],
    ["どちらとも言えません。", "uncertain", "considering"],
    ["I'm not sure.", "uncertain", "considering"],
    ["I don't know yet.", "uncertain", "considering"],
  ] as const)("grounds the explicit declaration %s in %s", (delta, gestureIntent, state) => {
    const pending = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "explicit",
      delta,
      phase: "assistant-responding",
    });
    const done = finishAssistantTranscript(pending.state, {
      utteranceId: "explicit",
      phase: "assistant-responding",
    });
    expect([...pending.cues, ...done.cues]).toEqual([
      expect.objectContaining({ gestureIntent, state }),
    ]);
  });

  it.each([
    "ありがとうございます。",
    "ありがとう、嬉しいです。",
    "問題を確認します。",
    "すみません、調べます。",
    "失敗しました。修正します。",
    "不確実なリスクを確認します。",
    "成功しませんでした。",
    "成功したとは言えません。",
    "本当に嬉しいわけではありません。",
    "悲しくありません。",
    "悲しいとは思いません。",
    "がっかりしたわけではありません。",
    "残念ではありません。",
    "残念ですが、まずは確認します。",
    "確信がないわけではありません。",
    "まだ分からないとは言っていません。",
    "成功したらお知らせします。",
    "悲しいと感じたら相談してください。",
    "成功しましたか？",
    "本当に嬉しいですか？",
    "まだ分かりませんか？",
    "『大成功です』という表示を確認します。",
    "「やった！本当に嬉しいです！」と書いてください。",
    "「まだ分かりません。悲しいです。」という返答の例です。",
    '"We did it!" is an example, not a result.',
    "'I'm disappointed.' is a quoted sentence.",
    "`まだ分かりません。`を削除しました。",
    "「やった！本当に嬉しいです！",
    "We did not succeed.",
    "I'm not sad.",
    "I'm not uncertain.",
    "If we succeeded, we could continue.",
  ])("does not infer salient acting from courtesy, negation, questions or quoted %s", (delta) => {
    const pending = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "not-a-declaration",
      delta,
      phase: "assistant-speaking",
    });
    const done = finishAssistantTranscript(pending.state, {
      utteranceId: "not-a-declaration",
      phase: "assistant-speaking",
    });
    expect(
      [...pending.cues, ...done.cues].some((cue) =>
        ["celebrate", "sad", "uncertain"].includes(cue.gestureIntent ?? "none"),
      ),
    ).toBe(false);
  });

  it("preserves quoted declarations and explicit acting across every transcript chunk boundary", () => {
    const text = "「やった！悲しいです。」は引用です。まだ分かりません。ついに成功しました！";
    const input = { utteranceId: "quoted-chunks", phase: "assistant-speaking" } as const;
    const whole = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      ...input,
      delta: text,
    });
    expect(whole.cues.map((cue) => cue.gestureIntent)).toEqual(["uncertain", "celebrate"]);
    for (let splitAt = 1; splitAt < text.length; splitAt++) {
      const first = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
        ...input,
        delta: text.slice(0, splitAt),
      });
      const second = resolveAssistantTranscriptDelta(first.state, {
        ...input,
        delta: text.slice(splitAt),
      });
      expect([...first.cues, ...second.cues]).toEqual(whole.cues);
      expect(second.state).toEqual(whole.state);
    }
  });

  it("chunk 境界をまたぐ節を agree cue へ決定論的に解決する", () => {
    const first = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
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
        state: "acknowledging",
        expression: "relaxed",
        gestureIntent: "agree",
        intensity: "small",
      }),
    ]);
  });

  it("どの文字位置で chunk を分けても同じ cue と state になる", () => {
    const text = "うん、そうですね。ありがとう！";
    const whole = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta: text,
      phase: "assistant-speaking",
    });

    for (let splitAt = 1; splitAt < text.length; splitAt += 1) {
      const first = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
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

  it("emits a subtle grounded progress state for routine completion language", () => {
    const result = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta: "ファイルを三つ読みました。次へ進みます。",
      phase: "assistant-speaking",
    });

    expect(result.cues).toEqual([
      expect.objectContaining({
        state: "progressing",
        expression: "neutral",
        gestureIntent: "none",
        intensity: "small",
      }),
    ]);
  });

  it("leaves ordinary Japanese explanation emotion-free for the audio-grounded conversation baseline", () => {
    const result = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "explanation",
      delta:
        "設定画面には三つの項目があります。左側の一覧から対象を選択できます。保存すると変更が反映されます。",
      phase: "assistant-speaking",
    });
    expect(result.cues).toEqual([]);
    expect(result.state.elapsedSpeechMs).toBe(4_500);
  });

  it("transcript done で句点のない末尾を flush する", () => {
    const pending = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
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
      expect.objectContaining({
        state: "considering",
        expression: "neutral",
        gestureIntent: "consider",
        intensity: "small",
      }),
    ]);
  });

  it("複数節の cue は発話内の文字位置に応じた相対時刻を持つ", () => {
    const result = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta: "うん、そうですね。ありがとう！",
      phase: "assistant-speaking",
    });

    expect(result.cues).toHaveLength(2);
    expect(result.cues[0].atMs).toBeGreaterThan(0);
    expect(result.cues[1].atMs).toBeGreaterThan(0);
    expect(result.cues[1].expression).toBe("happy");
    expect(result.cues[1].state).toBe("appreciative");
    expect(result.cues[1].gestureIntent).toBe("none");
    expect(result.cues[1].intensity).toBe("medium");
  });

  it("user speaking / interrupted 中の delta は捨てて resolver を reset する", () => {
    const pending = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
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
    expect(interrupted.state).toEqual(createStateExpressionResolverState());
  });

  it.each([
    "user-speaking",
    "interrupted",
    "disconnected",
  ] as const)("%s では cue を生成しない", (phase) => {
    const result = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta: "ありがとう。",
      phase,
    });

    expect(result.cues).toEqual([]);
  });

  it("utterance が変わった時は前発話の未確定 text を結合しない", () => {
    const pending = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
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
    const result = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta: "[gesture:nod] 続けます。",
      phase: "assistant-speaking",
    });

    expect(result.cues).toEqual([]);
  });

  it("keeps difficult reasoning concerned rather than relaxed", () => {
    const result = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta: "ここは慎重な検討が必要で、難しい問題です。",
      phase: "assistant-speaking",
    });

    expect(result.cues).toEqual([
      expect.objectContaining({
        state: "concerned",
        expression: "sad",
        expressionWeight: 0.36,
        gestureIntent: "consider",
        intensity: "small",
        durationMs: 3_200,
      }),
    ]);
  });

  it.each([
    ["申し訳ありません。", "concerned", "medium"],
    ["本当にびっくりしました！", "surprised", "medium"],
    ["ありがとう、嬉しいです。", "appreciative", "medium"],
    ["重要なポイントです。", "emphatic", "medium"],
    ["大丈夫、対応できます。", "reassuring", "small"],
    ["確認します。", "considering", "small"],
  ] as const)("maps %s to grounded %s with %s intensity", (delta, state, intensity) => {
    const result = resolveAssistantTranscriptDelta(createStateExpressionResolverState(), {
      utteranceId: "utterance-1",
      delta,
      phase: "assistant-speaking",
    });

    expect(result.cues[0]).toMatchObject({ state, intensity });
    expect(result.cues[0].durationMs).toBeGreaterThanOrEqual(2_000);
    expect(result.cues[0].durationMs).toBeLessThanOrEqual(4_000);
  });
});
