import type { PersonaDefinition } from "@yorishiro/sdk";
import { describe, expect, it, vi } from "vitest";
import type { PersonaEntry } from "./types";
import {
  isPackLocalVoiceRef,
  isSafeVoiceAssetPath,
  normalizeVoiceAssetPath,
  resolveBundledPersonaVoiceAsset,
  resolvePersonaVoiceClipWith,
} from "./voice-asset-resolver";

const persona: PersonaDefinition = {
  id: "singer",
  name: "Singer",
  world: { body: "", voice: "", space: "" },
  logReading: { readWhen: { kind: "never" }, framing: "absent", windowSize: 0 },
};

const entry = (overrides: Partial<PersonaEntry> = {}): PersonaEntry => ({
  id: "singer",
  manifest: {
    id: "singer",
    type: "persona",
    version: "0.0.0",
    charminalVersion: "*",
    entry: "persona.js",
  },
  persona,
  origin: "user",
  entryPath: "/Users/me/.charminal/packs/singer/persona.js",
  ...overrides,
});

describe("voice-asset-resolver", () => {
  it("pack-local voice ref だけを local asset として扱う", () => {
    expect(isPackLocalVoiceRef("./assets/vocal.wav")).toBe(true);
    expect(isPackLocalVoiceRef("assets/vocal.wav")).toBe(true);
    expect(isPackLocalVoiceRef("voice:thinking/foo")).toBe(false);
    expect(isPackLocalVoiceRef("https://example.com/vocal.wav")).toBe(false);
  });

  it("traversal や absolute URL を拒否する", () => {
    expect(isSafeVoiceAssetPath("./assets/vocal.wav")).toBe(true);
    expect(isSafeVoiceAssetPath("./assets/../secret.wav")).toBe(false);
    expect(isSafeVoiceAssetPath("./foo/..")).toBe(false);
    expect(isSafeVoiceAssetPath("assets/foo/..")).toBe(false);
    expect(isSafeVoiceAssetPath("assets/./vocal.wav")).toBe(false);
    expect(isSafeVoiceAssetPath("../secret.wav")).toBe(false);
    expect(isSafeVoiceAssetPath("file:///tmp/vocal.wav")).toBe(false);
  });

  it("leading ./ を正規化する", () => {
    expect(normalizeVoiceAssetPath("./assets/vocal.wav")).toBe("assets/vocal.wav");
  });

  it("bundled persona asset を import map から解決する", () => {
    expect(
      resolveBundledPersonaVoiceAsset(
        entry({ origin: "bundled", entryPath: undefined }),
        "./assets/vocal.wav",
        {
          "/bundled-packs/personas/singer/assets/vocal.wav": "/assets/vocal.hash.wav",
        },
      ),
    ).toBe("/assets/vocal.hash.wav");
  });

  it("user persona asset を entryPath から asset URL に解決する", async () => {
    const resolveUser = vi.fn(async () => "asset://vocal.wav");

    await expect(
      resolvePersonaVoiceClipWith(entry(), "./assets/vocal.wav", {
        resolveBundled: vi.fn(() => null),
        resolveUser,
      }),
    ).resolves.toBe("asset://vocal.wav");
    expect(resolveUser).toHaveBeenCalledWith(
      "/Users/me/.charminal/packs/singer/persona.js",
      "./assets/vocal.wav",
    );
  });

  it("shared voice ref は pack-local resolver では解決しない", async () => {
    await expect(
      resolvePersonaVoiceClipWith(entry(), "voice:thinking/foo", {
        resolveBundled: vi.fn(() => null),
        resolveUser: vi.fn(async () => "asset://unexpected.wav"),
      }),
    ).resolves.toBeNull();
  });
});
