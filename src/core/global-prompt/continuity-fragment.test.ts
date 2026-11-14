import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../runtime/persona-registry", () => ({ getPersonaRegistry: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import type { ContinuitySnapshot } from "../../runtime/continuity/types";
import { continuityPrompt, readContinuityPrompt } from "./continuity-fragment";
import { MAX_CONTINUITY_UTF8_BYTES } from "./voice-continuity";

beforeEach(() => vi.resetAllMocks());

it("passes current understanding and evidence references without copying the entire history", async () => {
  vi.mocked(invoke).mockResolvedValue({
    personaId: "yori-ja",
    revision: 1,
    phase: "idle",
    reflections: [],
    error: null,
    lastObservedAt: null,
    understandings: [
      {
        id: "preference",
        title: "大切にしていること",
        value: "体験から考えてほしい",
        certainty: "confirmed",
        sourceIds: ["message-3"],
        updatedAt: 1,
        revisions: [{ value: "old understanding", sourceIds: ["message-1"] }],
      },
    ],
    messages: [
      { id: "legacy", role: "user", content: "old diary", source: "legacy", createdAt: 0 },
      {
        id: "message-3",
        role: "user",
        content: "いまの草案を見たい",
        source: "conversation",
        createdAt: 1,
      },
    ],
    drafts: [
      {
        id: "draft-1",
        title: "草案",
        content: "actual draft",
        status: "ready",
        sourceIds: ["message-3"],
        createdAt: 1,
        updatedAt: 1,
        reason: "Requested",
      },
      {
        id: "draft-2",
        title: "見送り済み",
        content: "dismissed body",
        status: "dismissed",
        sourceIds: ["message-3"],
        createdAt: 1,
        updatedAt: 1,
        reason: "Declined",
      },
    ],
  });
  const prompt = await readContinuityPrompt("yori-ja");
  expect(invoke).toHaveBeenCalledWith("continuity_status", { personaId: "yori-ja" });
  expect(prompt).toContain("体験から考えてほしい");
  expect(prompt).toContain("message-3");
  expect(prompt).toContain("continuity_context");
  expect(prompt).toContain("continuity_observe");
  expect(prompt).not.toContain("old understanding");
  expect(prompt).not.toContain("old diary");
  expect(prompt).toContain("いまの草案を見たい");
  expect(prompt).toContain("actual draft");
  expect(prompt).toContain("見送り済み");
  expect(prompt).not.toContain("dismissed body");
});

it("does not invent memories when no persona is active", async () => {
  expect(await readContinuityPrompt(null)).toBe("");
  expect(invoke).not.toHaveBeenCalled();
});

it("keeps default terminal context compact without filling unused space from older history", () => {
  const value: ContinuitySnapshot = {
    personaId: "yori-ja",
    revision: 1,
    phase: "idle",
    reflections: [],
    understandings: [],
    drafts: [],
    error: null,
    lastObservedAt: null,
    messages: Array.from({ length: 12 }, (_, index) => ({
      id: `message-${index}`,
      role: "user",
      source: "conversation",
      createdAt: index,
      content: `Earlier topic ${index}`,
    })),
  };
  const before = JSON.stringify(value);
  const prompt = continuityPrompt(value);
  const data = JSON.parse(prompt.split("Remembered evidence JSON:\n")[1]);
  expect(data.conversation.map((message: { id: string }) => message.id)).toEqual([
    "message-6",
    "message-7",
    "message-8",
    "message-9",
    "message-10",
    "message-11",
  ]);
  expect(data.omitted.messages).toBe(6);
  expect(prompt).not.toContain("Earlier topic 0");
  expect(prompt).toContain("continuity_context");
  expect(prompt).toContain("continuity_observe");
  expect(prompt).not.toContain("voice continuity");
  expect(new TextEncoder().encode(prompt).length).toBeLessThan(4 * 1024);
  expect(JSON.stringify(value)).toBe(before);
});

it("counts terminal guidance in the UTF-8 budget and preserves explicit memory source references", () => {
  const value: ContinuitySnapshot = {
    personaId: "yori-ja",
    revision: 1,
    phase: "idle",
    reflections: [],
    understandings: [],
    drafts: [],
    error: null,
    lastObservedAt: null,
    messages: Array.from({ length: 20 }, (_, index) => ({
      id: `message-${index}`,
      role: "user",
      source: "conversation",
      createdAt: index,
      content:
        index === 19
          ? "最新の依頼です。まず草案を見せてください"
          : `冒頭😀${"原文🧑‍💻".repeat(2000)}末尾🚀`,
    })),
    explicitMemories: [{ requestMessageId: "message-0", sourceIds: ["message-0"] }],
  };
  const prompt = continuityPrompt(value);
  const data = JSON.parse(prompt.split("Remembered evidence JSON:\n")[1]);
  expect(new TextEncoder().encode(prompt).length).toBeLessThanOrEqual(MAX_CONTINUITY_UTF8_BYTES);
  expect(prompt).toContain("最新の依頼です。まず草案を見せてください");
  expect(data.explicitMemories[0].requestMessageId).toBe("message-0");
  expect(data.explicitMemories[0].sources[0].content.partial).toBe(true);
  const excerpt = data.explicitMemories[0].sources[0].content.text;
  expect(new TextDecoder().decode(new TextEncoder().encode(excerpt))).toBe(excerpt);
  expect(prompt).toContain("omitted/partial information");
});
