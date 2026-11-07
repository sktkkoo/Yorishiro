import { invoke } from "@tauri-apps/api/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ContinuitySnapshot } from "../../runtime/continuity/types";
import {
  MAX_VOICE_CONTINUITY_UTF8_BYTES,
  readVoiceContinuityPrompt,
  voiceContinuityPrompt,
} from "./voice-continuity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

function snapshot(): ContinuitySnapshot {
  return {
    personaId: "yori-ja",
    revision: 1,
    phase: "idle",
    messages: [],
    understandings: [],
    drafts: [],
    reflections: [],
    error: null,
    lastObservedAt: null,
    nextStep: null,
  };
}

function evidence(prompt: string) {
  return JSON.parse(prompt.split("Remembered evidence JSON:\n")[1] ?? "{}");
}

beforeEach(() => vi.resetAllMocks());

describe("bounded voice continuity", () => {
  it("keeps newest intent, corrections and exact references while bounding huge Japanese history and drafts", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      messages: [
        ...Array.from({ length: 80 }, (_, index) => ({
          id: `old-${index}`,
          role: "user" as const,
          source: "conversation" as const,
          content: `古い依頼${index}${"過去の会話😀".repeat(3000)}`,
          createdAt: index,
        })),
        {
          id: "latest-intent",
          role: "user",
          source: "voice",
          content: "訂正です。公開せず、まず現在の草案を見せてください。",
          createdAt: 100,
        },
      ],
      understandings: [
        {
          id: "corrected-boundary",
          title: "公開範囲の訂正",
          value: "公開せず草案を本人に見せる",
          certainty: "confirmed",
          sourceIds: ["latest-intent"],
          updatedAt: 100,
          revisions: [{ value: "古い解釈", reason: "訂正", sourceIds: ["old-1"], createdAt: 1 }],
        },
      ],
      drafts: [
        {
          id: "large-draft",
          title: "現在の草案",
          content: "本文を勝手に要約したことにしないでください🧑‍💻".repeat(12000),
          reason: "依頼された草案",
          status: "ready",
          sourceIds: ["latest-intent"],
          createdAt: 1,
          updatedAt: 100,
        },
      ],
      nextStep: "草案の全文を確認してから回答する",
    };
    const original = JSON.stringify(value);
    const prompt = voiceContinuityPrompt(value);
    const data = evidence(prompt);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      MAX_VOICE_CONTINUITY_UTF8_BYTES,
    );
    expect(prompt).toContain("訂正です。公開せず");
    expect(data.understandings[0]).toMatchObject({
      id: "corrected-boundary",
      sourceIds: ["latest-intent"],
    });
    expect(data.drafts[0]).toMatchObject({
      id: "large-draft",
      bodyOmitted: true,
      retrieveBeforeUsingBody: true,
    });
    expect(data.drafts[0]).not.toHaveProperty("content");
    expect(data.omitted.messages).toBeGreaterThan(0);
    expect(data.nextStep.text).toBe("草案の全文を確認してから回答する");
    expect(prompt).toContain("continuity_context");
    expect(prompt).toContain("silence grants permission");
    expect(prompt).not.toContain("古い解釈");
    expect(JSON.stringify(value)).toBe(original);
  });

  it("marks a clipped newest record explicitly and preserves Unicode head and tail", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      messages: [
        {
          id: "huge-current-message",
          role: "user",
          source: "conversation",
          createdAt: 1,
          content: `冒頭😀${"日本語😀🧑‍💻".repeat(20000)}末尾の最新条件🚀`,
        },
      ],
    };
    const prompt = voiceContinuityPrompt(value);
    const selected = evidence(prompt).conversation[0];
    expect(selected.id).toBe("huge-current-message");
    expect(selected.content.partial).toBe(true);
    expect(selected.content.originalUtf8Bytes).toBeGreaterThan(MAX_VOICE_CONTINUITY_UTF8_BYTES);
    expect(selected.content.text).toContain("冒頭😀");
    expect(selected.content.text).toContain("末尾の最新条件🚀");
    expect(selected.content.text).toContain("retrieve full source");
    // Round-tripping UTF-8 would replace a split surrogate with U+FFFD.
    expect(new TextDecoder().decode(new TextEncoder().encode(selected.content.text))).toBe(
      selected.content.text,
    );
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      MAX_VOICE_CONTINUITY_UTF8_BYTES,
    );
  });

  it("bounds JSON escaping overhead and omits enormous exact IDs instead of clipping references", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      messages: [
        {
          id: "x".repeat(20000),
          role: "user",
          source: "conversation",
          content: "older",
          createdAt: 1,
        },
        {
          id: "latest",
          role: "user",
          source: "conversation",
          content: "\u0001".repeat(20000),
          createdAt: 2,
        },
      ],
      nextStep: "\u0001".repeat(20000),
    };
    const prompt = voiceContinuityPrompt(value);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      MAX_VOICE_CONTINUITY_UTF8_BYTES,
    );
    expect(evidence(prompt).conversation.map((message: { id: string }) => message.id)).toEqual([
      "latest",
    ]);
    expect(evidence(prompt).omitted.messages).toBe(1);
  });

  it("preserves a small completed draft and ignores phase-only revisions for passive deduplication", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      drafts: [
        {
          id: "short-draft",
          title: "短い草案",
          content: "実際の完成した草案です。",
          reason: "依頼",
          status: "ready",
          sourceIds: ["user-1"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    const prompt = voiceContinuityPrompt(value);
    expect(evidence(prompt).drafts[0].content).toBe("実際の完成した草案です。");
    expect(
      voiceContinuityPrompt({ ...value, phase: "working", revision: 200, lastObservedAt: 900 }),
    ).toBe(prompt);
  });

  it("omits legacy conversation and dismissed draft bodies without implying they were authorized", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      messages: [
        {
          id: "legacy",
          role: "user",
          source: "legacy",
          content: "unverified old note",
          createdAt: 1,
        },
      ],
      drafts: [
        {
          id: "dismissed",
          title: "見送った案",
          content: "Do not revive this draft",
          reason: "old",
          status: "dismissed",
          sourceIds: ["legacy"],
          createdAt: 1,
          updatedAt: 1,
        },
      ],
    };
    const prompt = voiceContinuityPrompt(value);
    expect(prompt).not.toContain("unverified old note");
    expect(prompt).not.toContain("Do not revive this draft");
    expect(evidence(prompt).drafts[0]).toMatchObject({
      id: "dismissed",
      status: "dismissed",
      bodyOmitted: true,
    });
  });

  it("reads the authoritative persona snapshot and makes no native request for null persona", async () => {
    expect(await readVoiceContinuityPrompt(null)).toBe("");
    expect(invoke).not.toHaveBeenCalled();
    const value = snapshot();
    vi.mocked(invoke).mockResolvedValue(value);
    expect(await readVoiceContinuityPrompt("yori-ja")).toBe(voiceContinuityPrompt(value));
    expect(invoke).toHaveBeenCalledExactlyOnceWith("continuity_status", { personaId: "yori-ja" });
  });
});
