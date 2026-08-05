import { describe, expect, it } from "vitest";
import { isCodexVoiceRejectionMessage } from "./voice-rejection";

describe("isCodexVoiceRejectionMessage", () => {
  it.each([
    "Invalid voice: nonexistent",
    "voice 'foo' is not supported",
    "Unsupported voice",
    "unknown voice requested",
    "The requested voice is unavailable in v3",
    "Voice not available for this account",
    "unrecognized voice_id",
    "realtime v3 does not support voice marin",
    "no such voice",
  ])("accepts an explicit voice rejection: %s", (message) => {
    expect(isCodexVoiceRejectionMessage(message)).toBe(true);
  });

  it.each([
    // 認証・権限・接続・timeout は voice fallback で隠さない。
    "account failed",
    "Voice requires Codex to be signed in with ChatGPT or an API key.",
    "thread/realtime/start timed out",
    "Codex app-server connection closed",
    "permission denied",
    "unauthorized",
    "invalid params",
    "realtime is not enabled for this account",
    // "voice" の部分一致（invoice 等）は voice への言及として扱わない。
    "invalid invoice number",
    "",
  ])("rejects a generic failure: %s", (message) => {
    expect(isCodexVoiceRejectionMessage(message)).toBe(false);
  });
});
