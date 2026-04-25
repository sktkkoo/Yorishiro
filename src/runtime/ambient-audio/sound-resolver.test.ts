import { describe, expect, it } from "vitest";
import { buildSharedSoundMap, pathToStem, resolveSharedSound } from "./sound-resolver";

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

describe("buildSharedSoundMap", () => {
  it("builds a Map from glob result", () => {
    const map = buildSharedSoundMap({
      "/bundled-packs/shared/sounds/rain.mp3": "/__assets/rain.hash.mp3",
      "/bundled-packs/shared/sounds/wind.ogg": "/__assets/wind.hash.ogg",
    });
    expect(map.get("rain")).toBe("/__assets/rain.hash.mp3");
    expect(map.get("wind")).toBe("/__assets/wind.hash.ogg");
    expect(map.size).toBe(2);
  });

  it("handles namespaced sounds without collision", () => {
    const map = buildSharedSoundMap({
      "/bundled-packs/shared/sounds/rain.mp3": "/__a/rain.mp3",
      "/bundled-packs/shared/sounds/lofi-vibes/rain.mp3": "/__a/lofi-rain.mp3",
    });
    expect(map.get("rain")).toBe("/__a/rain.mp3");
    expect(map.get("lofi-vibes/rain")).toBe("/__a/lofi-rain.mp3");
  });

  it("throws on duplicate stem across extensions", () => {
    expect(() =>
      buildSharedSoundMap({
        "/bundled-packs/shared/sounds/rain.mp3": "/__a/rain.mp3",
        "/bundled-packs/shared/sounds/rain.wav": "/__a/rain.wav",
      }),
    ).toThrow(/Duplicate shared sound name 'rain'.*rain\.wav.*rain\.mp3/);
  });

  it("throws on duplicate stem within the same namespace", () => {
    expect(() =>
      buildSharedSoundMap({
        "/bundled-packs/shared/sounds/lofi/cafe.mp3": "/__a/c.mp3",
        "/bundled-packs/shared/sounds/lofi/cafe.wav": "/__a/c.wav",
      }),
    ).toThrow(/Duplicate shared sound name 'lofi\/cafe'.*lofi\/cafe\.wav.*lofi\/cafe\.mp3/);
  });
});

describe("resolveSharedSound (deps-injected)", () => {
  const sharedMap = new Map<string, string>([
    ["rain", "/__assets/rain.hash.mp3"],
    ["lofi-vibes/cafe-loop", "/__assets/cafe.hash.mp3"],
  ]);

  it("returns URL for known stem (flat)", () => {
    expect(resolveSharedSound("rain", sharedMap)).toBe("/__assets/rain.hash.mp3");
  });

  it("returns URL for known namespaced stem", () => {
    expect(resolveSharedSound("lofi-vibes/cafe-loop", sharedMap)).toBe("/__assets/cafe.hash.mp3");
  });

  it("returns null when stem is missing", () => {
    expect(resolveSharedSound("missing", sharedMap)).toBeNull();
    expect(resolveSharedSound("lofi-vibes/missing", sharedMap)).toBeNull();
  });
});
