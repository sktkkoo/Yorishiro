/**
 * Tests for injectPersonaPrompt — persona.md inject pure 関数の検証。
 */

import { describe, expect, it } from "vitest";
import type { PersonaDefinition } from "../../sdk/persona";
import { injectPersonaPrompt } from "./persona-md-injection";

const baseDef: PersonaDefinition = {
  id: "test-persona",
  name: "テスト住人",
  // thinking は optional（Task 1 で optional 化済み）
} as unknown as PersonaDefinition;

describe("injectPersonaPrompt", () => {
  it("injects md text into empty thinking", () => {
    const result = injectPersonaPrompt(baseDef, "私はテスト住人。");
    expect(result.thinking?.systemPromptAddition).toBe("私はテスト住人。");
  });

  it("injects md text when thinking exists but systemPromptAddition empty", () => {
    const defWithEmpty: PersonaDefinition = {
      ...baseDef,
      thinking: { systemPromptAddition: "" },
    };
    const result = injectPersonaPrompt(defWithEmpty, "md content here");
    expect(result.thinking?.systemPromptAddition).toBe("md content here");
  });

  it("preserves existing systemPromptAddition when explicitly set in .js", () => {
    const defWithExplicit: PersonaDefinition = {
      ...baseDef,
      thinking: { systemPromptAddition: "explicit prompt" },
    };
    const result = injectPersonaPrompt(defWithExplicit, "md content should be ignored");
    expect(result.thinking?.systemPromptAddition).toBe("explicit prompt");
  });

  it("no-op when md text is empty and thinking also empty", () => {
    const result = injectPersonaPrompt(baseDef, "");
    expect(result).toBe(baseDef);
  });

  it("no-op when md text is whitespace only", () => {
    const result = injectPersonaPrompt(baseDef, "   \n  \n");
    expect(result).toBe(baseDef);
  });

  it("trims injected md text", () => {
    const result = injectPersonaPrompt(baseDef, "\n  trimmed content  \n");
    expect(result.thinking?.systemPromptAddition).toBe("trimmed content");
  });

  it("preserves other fields (reflex / world / logReading)", () => {
    const defWithOthers: PersonaDefinition = {
      ...baseDef,
      reflex: { customTriggers: [], responses: {} },
      world: { body: "vrm:x", voice: "voice:y" },
    } as unknown as PersonaDefinition;
    const result = injectPersonaPrompt(defWithOthers, "md content");
    expect(result.reflex).toBe(defWithOthers.reflex);
    expect(result.world).toBe(defWithOthers.world);
  });
});
