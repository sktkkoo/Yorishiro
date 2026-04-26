import { describe, expect, it } from "vitest";
import {
  PackValidationError,
  validateAmbientUiPackDefinition,
  validateEffectDefinition,
  validatePersonaDefinition,
  validateUiPackDefinition,
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

  it("accepts missing thinking (loader が後から inject する)", () => {
    // thinking は optional — persona.md から loader が inject することがある
    expect(() =>
      validatePersonaDefinition({ id: "a", name: "A", reflex: { responses: {} } }),
    ).not.toThrow();
  });

  it("rejects non-object thinking when present", () => {
    expect(() =>
      validatePersonaDefinition({ id: "a", name: "A", thinking: "bad", reflex: { responses: {} } }),
    ).toThrow(/thinking/);
  });

  it("accepts missing reflex (minimal persona.js)", () => {
    // reflex は optional — minimal persona pack（id + name のみ）を accept する
    expect(() => validatePersonaDefinition({ id: "a", name: "A", thinking: {} })).not.toThrow();
  });

  it("rejects reflex without responses object when reflex is present", () => {
    expect(() =>
      validatePersonaDefinition({ id: "a", name: "A", thinking: {}, reflex: {} }),
    ).toThrow(/responses/);
  });

  it("accepts missing world and logReading", () => {
    // minimal persona は id + name のみで validator を通過する
    expect(() => validatePersonaDefinition({ id: "a", name: "A" })).not.toThrow();
  });

  it("rejects non-object world when present", () => {
    expect(() => validatePersonaDefinition({ id: "a", name: "A", world: "bad" })).toThrow(/world/);
  });
});

describe("validateUiPackDefinition", () => {
  const validUi = {
    id: "sample-ui",
    type: "ui",
    layout: {},
    mount: () => ({ dispose: () => {} }),
  };

  it("returns the value when shape is valid", () => {
    expect(validateUiPackDefinition(validUi)).toBe(validUi);
  });

  it("rejects non-object inputs", () => {
    expect(() => validateUiPackDefinition(null)).toThrow(PackValidationError);
  });

  it("rejects missing or wrong top-level fields", () => {
    expect(() => validateUiPackDefinition({ type: "ui", layout: {}, mount: () => {} })).toThrow(
      /id/,
    );
    expect(() =>
      validateUiPackDefinition({ id: "x", type: "effect", layout: {}, mount: () => {} }),
    ).toThrow(/type/);
    expect(() => validateUiPackDefinition({ id: "x", type: "ui", mount: () => {} })).toThrow(
      /layout/,
    );
    expect(() => validateUiPackDefinition({ id: "x", type: "ui", layout: {} })).toThrow(/mount/);
  });
});

describe("validateAmbientUiPackDefinition", () => {
  const validAmbientUi = {
    id: "sample-ambient",
    type: "ambient-ui",
    mount: () => ({ dispose: () => {} }),
  };

  it("returns the value when shape is valid", () => {
    expect(validateAmbientUiPackDefinition(validAmbientUi)).toBe(validAmbientUi);
  });

  it("rejects non-object inputs", () => {
    expect(() => validateAmbientUiPackDefinition(null)).toThrow(PackValidationError);
    expect(() => validateAmbientUiPackDefinition(42)).toThrow(PackValidationError);
    expect(() => validateAmbientUiPackDefinition("ambient-ui")).toThrow(PackValidationError);
  });

  it("rejects missing or non-string id", () => {
    expect(() => validateAmbientUiPackDefinition({ type: "ambient-ui", mount: () => {} })).toThrow(
      /id/,
    );
    expect(() =>
      validateAmbientUiPackDefinition({ id: 99, type: "ambient-ui", mount: () => {} }),
    ).toThrow(/id/);
  });

  it("rejects wrong or missing type", () => {
    expect(() => validateAmbientUiPackDefinition({ id: "x", type: "ui", mount: () => {} })).toThrow(
      /type/,
    );
    expect(() => validateAmbientUiPackDefinition({ id: "x", mount: () => {} })).toThrow(/type/);
  });

  it("rejects non-function mount", () => {
    expect(() =>
      validateAmbientUiPackDefinition({ id: "x", type: "ambient-ui", mount: "start" }),
    ).toThrow(/mount/);
    expect(() => validateAmbientUiPackDefinition({ id: "x", type: "ambient-ui" })).toThrow(/mount/);
  });

  it("accepts extra fields (tolerant toward future extensions)", () => {
    expect(() =>
      validateAmbientUiPackDefinition({
        id: "x",
        type: "ambient-ui",
        mount: () => ({ dispose: () => {} }),
        extraField: "ignored",
      }),
    ).not.toThrow();
  });
});

describe("PackValidationError", () => {
  it("has a name for identification", () => {
    const err = new PackValidationError("boom");
    expect(err.name).toBe("PackValidationError");
    expect(err.message).toBe("boom");
  });
});
