import { describe, expect, it, vi } from "vitest";
import {
  buildSharedVoiceMap,
  pathToVoiceStem,
  resolveSharedVoice,
  resolveSharedVoiceRef,
} from "./voice-clip-resolver";

describe("voice-clip-resolver", () => {
  it("shared voice path からカテゴリ付き stem を抽出する", () => {
    expect(pathToVoiceStem("/bundled-packs/shared/voices/thinking/think_aa_001.wav")).toBe(
      "thinking/think_aa_001",
    );
  });

  it("voice:<stem> を shared voice URL に解決する", () => {
    const map = buildSharedVoiceMap({
      "/bundled-packs/shared/voices/thinking/think_aa_001.wav": "/assets/think_aa_001.wav",
    });

    expect(resolveSharedVoice("thinking/think_aa_001", map)).toBe("/assets/think_aa_001.wav");
    expect(resolveSharedVoice("think_aa_001", map)).toBe("/assets/think_aa_001.wav");
    expect(resolveSharedVoiceRef("voice:thinking/think_aa_001", map)).toBe(
      "/assets/think_aa_001.wav",
    );
    expect(resolveSharedVoiceRef("voice:think_aa_001", map)).toBe("/assets/think_aa_001.wav");
  });

  it("basename alias の衝突は full stem を残して alias だけ skip する", () => {
    const warn = vi.fn();
    const map = buildSharedVoiceMap(
      {
        "/bundled-packs/shared/voices/ack/foo.wav": "/assets/ack/foo.wav",
        "/bundled-packs/shared/voices/error/foo.wav": "/assets/error/foo.wav",
      },
      { warn },
    );

    expect(resolveSharedVoice("ack/foo", map)).toBe("/assets/ack/foo.wav");
    expect(resolveSharedVoice("error/foo", map)).toBe("/assets/error/foo.wav");
    expect(resolveSharedVoice("foo", map)).toBe("/assets/ack/foo.wav");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Duplicate shared voice name 'foo'"));
  });
});
