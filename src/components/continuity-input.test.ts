import { describe, expect, it } from "vitest";
import {
  activeContinuityInput,
  cancelCorrection,
  editContinuityInput,
  finishContinuityInput,
  forgetCorrection,
  readContinuityInput,
  selectCorrection,
  serializeContinuityInput,
} from "./continuity-input";

describe("continuity input drafts", () => {
  it("migrates normal and correction legacy drafts without mixing their targets", () => {
    const normal = readContinuityInput(JSON.stringify({ text: "Normal", correctionId: null }));
    expect(normal.normal.text).toBe("Normal");
    const correction = readContinuityInput(
      JSON.stringify({ text: "Correction", correctionId: "A" }),
    );
    expect(activeContinuityInput(correction).text).toBe("Correction");
    expect(correction.target.id).toBe("A");
    expect(activeContinuityInput(cancelCorrection(correction)).text).toBe("");
  });

  it("round trips normal, inactive and intentionally empty correction drafts, including dictionary-like IDs", () => {
    let input = editContinuityInput(readContinuityInput(null), "Normal");
    input = editContinuityInput(selectCorrection(input, "constructor", "Memory A"), "Edited A");
    input = editContinuityInput(selectCorrection(input, "__proto__", "Memory B"), "");
    const restored = readContinuityInput(serializeContinuityInput(input));
    expect(restored.normal.text).toBe("Normal");
    expect(restored.target.id).toBe("__proto__");
    expect(activeContinuityInput(restored).text).toBe("");
    expect(activeContinuityInput(selectCorrection(restored, "constructor", "New value")).text).toBe(
      "Edited A",
    );
  });

  it.each([
    "{",
    "[]",
    "null",
    '{"text":1,"correctionId":null}',
    '{"text":"draft","correctionId":42}',
    '{"version":2,"text":"draft","correctionId":null}',
    '{"version":1,"normal":false,"corrections":{},"correctionId":null}',
    '{"version":1,"normal":"draft","corrections":[],"correctionId":null}',
    '{"version":1,"normal":"draft","corrections":{"A":4},"correctionId":null}',
    '{"version":1,"normal":"draft","corrections":{"":"text"},"correctionId":null}',
    '{"version":1,"normal":"draft","corrections":{},"correctionId":"missing"}',
  ])("ignores malformed or incompatible storage: %s", (serialized) => {
    const input = readContinuityInput(serialized);
    expect(input.normal.text).toBe("");
    expect(input.corrections.size).toBe(0);
    expect(input.target.id).toBeNull();
  });

  it("clears an unchanged inactive submitted slot, but preserves new text and a reselected target", () => {
    const normal = editContinuityInput(readContinuityInput(null), "Normal");
    const submitted = selectCorrection(normal, "A", "Memory A");
    const other = editContinuityInput(selectCorrection(submitted, "B", "Memory B"), "Edited B");
    const completed = finishContinuityInput(other, submitted);
    expect(completed.corrections.has("A")).toBe(false);
    expect(activeContinuityInput(completed).text).toBe("Edited B");
    expect(completed.normal.text).toBe("Normal");
    const reselected = selectCorrection(other, "A", "Memory A");
    expect(finishContinuityInput(reselected, submitted)).toBe(reselected);
    const edited = editContinuityInput(submitted, "Newer A");
    expect(finishContinuityInput(edited, submitted)).toBe(edited);
    expect(activeContinuityInput(finishContinuityInput(submitted, submitted)).text).toBe("Normal");
  });

  it("forgetting removes only the matching correction and restores normal only for an active target", () => {
    let input = editContinuityInput(readContinuityInput(null), "Normal");
    input = selectCorrection(selectCorrection(input, "A", "Memory A"), "B", "Memory B");
    const withoutA = forgetCorrection(input, "A");
    expect(withoutA.corrections.has("A")).toBe(false);
    expect(activeContinuityInput(withoutA).text).toBe("Memory B");
    const withoutB = forgetCorrection(withoutA, "B");
    expect(withoutB.target.id).toBeNull();
    expect(activeContinuityInput(withoutB).text).toBe("Normal");
  });
});
