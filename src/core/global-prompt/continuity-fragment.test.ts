import { beforeEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../runtime/persona-registry", () => ({ getPersonaRegistry: vi.fn() }));

import { invoke } from "@tauri-apps/api/core";
import { readContinuityPrompt } from "./continuity-fragment";

beforeEach(() => vi.resetAllMocks());

it("passes current understanding and evidence references without copying the entire history", async () => {
  vi.mocked(invoke).mockResolvedValue({
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
      { content: "old diary", source: "legacy" },
      { content: "いまの草案を見たい", source: "conversation" },
    ],
    drafts: [
      { id: "draft-1", title: "草案", content: "actual draft", status: "ready" },
      { id: "draft-2", title: "見送り済み", content: "dismissed body", status: "dismissed" },
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
