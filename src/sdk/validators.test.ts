import { describe, expect, it } from "vitest";
import {
  PackValidationError,
  validateEffectDefinition,
  validatePersonaDefinition,
} from "./validators";

describe("validateEffectDefinition", () => {
  const validEffect = {
    id: "example-flash",
    type: "effect",
    run: async () => {},
  };

  it("returns the value when shape is valid", () => {
    expect(validateEffectDefinition(validEffect)).toBe(validEffect);
  });

  it("rejects non-object inputs", () => {
    expect(() => validateEffectDefinition(null)).toThrow(PackValidationError);
    expect(() => validateEffectDefinition(42)).toThrow(PackValidationError);
    expect(() => validateEffectDefinition("effect")).toThrow(PackValidationError);
  });

  it("rejects missing or non-string id", () => {
    expect(() => validateEffectDefinition({ type: "effect", run: () => {} })).toThrow(/id/);
    expect(() => validateEffectDefinition({ id: 123, type: "effect", run: () => {} })).toThrow(
      /id/,
    );
  });

  it("rejects wrong or missing type", () => {
    expect(() => validateEffectDefinition({ id: "x", type: "persona", run: () => {} })).toThrow(
      /type/,
    );
    expect(() => validateEffectDefinition({ id: "x", run: () => {} })).toThrow(/type/);
  });

  it("rejects non-function run", () => {
    expect(() => validateEffectDefinition({ id: "x", type: "effect", run: "go" })).toThrow(/run/);
    expect(() => validateEffectDefinition({ id: "x", type: "effect" })).toThrow(/run/);
  });
});

describe("validatePersonaDefinition", () => {
  const validPersona = {
    id: "example-persona",
    name: "Example",
    thinking: {},
    reflex: { responses: {} },
  };

  it("returns the value when shape is valid", () => {
    expect(validatePersonaDefinition(validPersona)).toBe(validPersona);
  });

  it("rejects non-object inputs", () => {
    expect(() => validatePersonaDefinition(null)).toThrow(PackValidationError);
  });

  it("rejects missing id or name", () => {
    expect(() =>
      validatePersonaDefinition({ name: "A", thinking: {}, reflex: { responses: {} } }),
    ).toThrow(/id/);
    expect(() =>
      validatePersonaDefinition({ id: "a", thinking: {}, reflex: { responses: {} } }),
    ).toThrow(/name/);
  });

  it("rejects missing or non-object thinking / reflex", () => {
    expect(() =>
      validatePersonaDefinition({ id: "a", name: "A", reflex: { responses: {} } }),
    ).toThrow(/thinking/);
    expect(() => validatePersonaDefinition({ id: "a", name: "A", thinking: {} })).toThrow(/reflex/);
  });

  it("rejects reflex without responses object", () => {
    expect(() =>
      validatePersonaDefinition({ id: "a", name: "A", thinking: {}, reflex: {} }),
    ).toThrow(/responses/);
  });
});

describe("PackValidationError", () => {
  it("has a name for identification", () => {
    const err = new PackValidationError("boom");
    expect(err.name).toBe("PackValidationError");
    expect(err.message).toBe("boom");
  });
});
