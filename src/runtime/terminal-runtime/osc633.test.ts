import { describe, expect, it } from "vitest";
import { decodeOsc633Value, encodeOsc633Value } from "./osc633";

describe("OSC 633 value escaping", () => {
  it("escapes command separators, spaces, backslashes, and control bytes", () => {
    expect(encodeOsc633Value("echo a;b\\c\n")).toBe("echo\\x20a\\x3Bb\\x5Cc\\x0A");
  });

  it("round-trips UTF-8 values through hex bytes", () => {
    const value = "printf 'こんにちは;ok'";
    expect(decodeOsc633Value(encodeOsc633Value(value))).toBe(value);
  });

  it("decodes lowercase and uppercase hex escapes", () => {
    expect(decodeOsc633Value("git\\x20status\\x3b\\X")).toBe("git status;\\X");
    expect(decodeOsc633Value("cwd\\x3D/tmp")).toBe("cwd=/tmp");
  });
});
