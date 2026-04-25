import { describe, expect, it } from "vitest";
import { pathToStem } from "./sound-resolver";

describe("pathToStem", () => {
  it("strips bundled-packs/shared/sounds/ prefix and extension (flat)", () => {
    expect(pathToStem("/bundled-packs/shared/sounds/rain.mp3")).toBe("rain");
  });

  it("preserves one-level namespace", () => {
    expect(pathToStem("/bundled-packs/shared/sounds/lofi-vibes/cafe-loop.mp3")).toBe(
      "lofi-vibes/cafe-loop",
    );
  });

  it("handles all 4 supported extensions", () => {
    expect(pathToStem("/bundled-packs/shared/sounds/a.mp3")).toBe("a");
    expect(pathToStem("/bundled-packs/shared/sounds/a.wav")).toBe("a");
    expect(pathToStem("/bundled-packs/shared/sounds/a.ogg")).toBe("a");
    expect(pathToStem("/bundled-packs/shared/sounds/a.m4a")).toBe("a");
  });
});
