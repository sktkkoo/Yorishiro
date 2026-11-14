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
  it("includes an explicit memory's original request and context without expanding the recent conversation window", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      messages: [
        {
          id: "preference",
          role: "user",
          source: "voice",
          content: "朝は日本語で短く話してほしい",
          createdAt: 1,
        },
        {
          id: "reply",
          role: "assistant",
          source: "voice",
          content: "朝は短く、日本語で話すね",
          createdAt: 2,
        },
        {
          id: "remember",
          role: "user",
          source: "voice",
          content: "それを覚えておいて",
          createdAt: 3,
        },
        ...Array.from({ length: 8 }, (_, index) => ({
          id: `recent-${index}`,
          role: "user" as const,
          source: "voice" as const,
          content: `最近の話 ${index}`,
          createdAt: index + 4,
        })),
      ],
      explicitMemories: [
        { requestMessageId: "remember", sourceIds: ["preference", "reply", "remember"] },
      ],
    };
    const before = JSON.stringify(value);
    const prompt = voiceContinuityPrompt(value);
    const data = evidence(prompt);
    expect(data.conversation.map((message: { id: string }) => message.id)).toEqual([
      "recent-2",
      "recent-3",
      "recent-4",
      "recent-5",
      "recent-6",
      "recent-7",
    ]);
    expect(data.explicitMemories).toHaveLength(1);
    expect(data.explicitMemories[0]).toMatchObject({
      requestMessageId: "remember",
      sourceIds: ["remember", "preference", "reply"],
      omittedSourceCount: 0,
    });
    expect(data.explicitMemories[0].sources[1].content.text).toBe("朝は日本語で短く話してほしい");
    expect(prompt).toContain("not independently confirmed fact or permission");
    expect(data.omitted.explicitMemories).toBe(0);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      MAX_VOICE_CONTINUITY_UTF8_BYTES,
    );
    expect(JSON.stringify(value)).toBe(before);
  });

  it("bounds explicit memory excerpts, marks missing context, and keeps current intent first", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      messages: [
        {
          id: "long-context",
          role: "assistant",
          source: "voice",
          content: `冒頭😀${"日本語🧑‍💻".repeat(8000)}末尾🚀`,
          createdAt: 1,
        },
        { id: "remember", role: "user", source: "voice", content: "Remember this", createdAt: 2 },
        {
          id: "latest",
          role: "user",
          source: "voice",
          content: "現在の訂正を優先してください",
          createdAt: 3,
        },
      ],
      explicitMemories: Array.from({ length: 12 }, () => ({
        requestMessageId: "remember",
        sourceIds: ["long-context", "missing"],
      })),
    };
    const prompt = voiceContinuityPrompt(value);
    const data = evidence(prompt);
    const memory = data.explicitMemories[0];
    expect(prompt).toContain("現在の訂正を優先してください");
    expect(memory.sources[1].content).toMatchObject({ partial: true });
    expect(memory.sources[1].content.text).toContain("冒頭😀");
    expect(memory.sources[1].content.text).toContain("末尾🚀");
    expect(new TextDecoder().decode(new TextEncoder().encode(memory.sources[1].content.text))).toBe(
      memory.sources[1].content.text,
    );
    expect(memory.omittedSourceCount).toBe(1);
    expect(memory.retrieveBeforeUsingOmittedSources).toBe(true);
    expect(data.explicitMemories.length).toBeLessThanOrEqual(8);
    expect(data.omitted.explicitMemories).toBe(12 - data.explicitMemories.length);
    expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(
      MAX_VOICE_CONTINUITY_UTF8_BYTES,
    );
  });

  it("keeps older retained messages out of ordinary voice context even when they fit", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      messages: [
        ...Array.from({ length: 9 }, (_, index) => ({
          id: `message-${index}`,
          role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
          source: "voice" as const,
          content: `Retained conversation ${index}`,
          createdAt: index,
        })),
        {
          id: "legacy",
          role: "user",
          source: "legacy",
          content: "Legacy records do not use a recent conversation slot",
          createdAt: 10,
        },
      ],
    };
    const original = JSON.stringify(value);
    const prompt = voiceContinuityPrompt(value);
    const data = evidence(prompt);
    expect(MAX_VOICE_CONTINUITY_UTF8_BYTES).toBe(8 * 1024);
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(4 * 1024);
    expect(data.conversation.map((message: { id: string }) => message.id)).toEqual([
      "message-3",
      "message-4",
      "message-5",
      "message-6",
      "message-7",
      "message-8",
    ]);
    expect(data.omitted.messages).toBe(3);
    expect(prompt).not.toContain("Retained conversation 0");
    expect(prompt).not.toContain("Legacy records do not use");
    expect(prompt).toContain("retrieve continuity_context for older retained records");
    expect(prompt).toContain("not an exhaustive lifetime history");
    expect(prompt).not.toContain("Full original conversation");
    expect(JSON.stringify(value)).toBe(original);
  });

  it("caps compact memories and drafts while prioritizing the latest correction over stale interpretations", () => {
    const value: ContinuitySnapshot = {
      ...snapshot(),
      understandings: Array.from({ length: 12 }, (_, index) => ({
        id: `memory-${index}`,
        title: "Preference",
        value: "Ask first",
        certainty: "confirmed" as const,
        sourceIds: ["user-1"],
        updatedAt: index,
        revisions:
          index <= 1
            ? [{ value: "Old", reason: "Correction", sourceIds: ["user-1"], createdAt: index }]
            : [],
      })),
      drafts: Array.from({ length: 5 }, (_, index) => ({
        id: `draft-${index}`,
        title: "Draft",
        content: "Short body",
        reason: "Requested",
        status: index === 4 ? ("dismissed" as const) : ("ready" as const),
        sourceIds: ["user-1"],
        createdAt: index,
        updatedAt: index,
      })),
    };
    const original = JSON.stringify(value);
    const prompt = voiceContinuityPrompt(value);
    const data = evidence(prompt);
    expect(new TextEncoder().encode(prompt).length).toBeLessThan(6 * 1024);
    expect(data.understandings.map((memory: { id: string }) => memory.id)).toEqual([
      "memory-1",
      "memory-11",
      "memory-10",
      "memory-9",
      "memory-8",
      "memory-7",
      "memory-6",
      "memory-5",
    ]);
    expect(data.drafts.map((draft: { id: string }) => draft.id)).toEqual([
      "draft-3",
      "draft-2",
      "draft-1",
    ]);
    expect(data.omitted).toMatchObject({ understandings: 4, drafts: 2 });
    expect(JSON.stringify(value)).toBe(original);
  });

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
