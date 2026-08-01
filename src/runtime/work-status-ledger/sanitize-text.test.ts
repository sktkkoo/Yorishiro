import { describe, expect, it } from "vitest";
import { MAX_NOTE_LENGTH, MAX_SUMMARY_LENGTH, sanitizeHumanText } from "./sanitize-text";

const ESC = "\u001b";
const BEL = "\u0007";
const NUL = "\u0000";
const NEL = "\u0085";
const DCS = "\u0090";
const CSI = "\u009b";
const OSC = "\u009d";
const ST = "\u009c";

describe("sanitizeHumanText", () => {
  it("keeps plain human-readable text as-is", () => {
    expect(sanitizeHumanText("テストを直して、vitest を通す", MAX_SUMMARY_LENGTH)).toBe(
      "テストを直して、vitest を通す",
    );
  });

  it("strips ANSI escape sequences from pasted terminal output", () => {
    const raw = `${ESC}[31mFAIL${ESC}[0m src/foo.test.ts ${ESC}]0;title${BEL}done`;
    expect(sanitizeHumanText(raw, MAX_SUMMARY_LENGTH)).toBe("FAIL src/foo.test.ts done");
  });

  it("strips the full ECMA-48 parameter range including colon and private markers", () => {
    const raw = [
      `${ESC}[38:2::255:0:0mred${ESC}[0m`,
      `${ESC}[?25lhidden${ESC}[?25h`,
      `${ESC}[>0cok`,
    ].join(" ");
    expect(sanitizeHumanText(raw, MAX_SUMMARY_LENGTH)).toBe("red hidden ok");
  });

  it("strips 8-bit C1 CSI/control strings plus standalone C1 controls", () => {
    const raw = [
      `${CSI}38:2::0:255:0mgreen${CSI}0m`,
      `${OSC}0;title${ST}done${NEL}next`,
      `${DCS}private-payload${ST}visible`,
    ].join(" ");
    expect(sanitizeHumanText(raw, MAX_SUMMARY_LENGTH)).toBe("green done next visible");
  });

  it("collapses control characters and whitespace runs into single spaces", () => {
    const raw = `line1\r\nline2\tline3${NUL}line4   line5`;
    expect(sanitizeHumanText(raw, MAX_SUMMARY_LENGTH)).toBe("line1 line2 line3 line4 line5");
  });

  it("truncates over-limit text with an ellipsis within the limit", () => {
    const raw = "あ".repeat(MAX_NOTE_LENGTH + 50);
    const sanitized = sanitizeHumanText(raw, MAX_NOTE_LENGTH);
    expect(sanitized.length).toBeLessThanOrEqual(MAX_NOTE_LENGTH);
    expect(sanitized.endsWith("…")).toBe(true);
  });

  it("returns an empty string when nothing human-readable remains", () => {
    expect(sanitizeHumanText(`${ESC}[2J${BEL} \r\n`, MAX_SUMMARY_LENGTH)).toBe("");
  });
});
