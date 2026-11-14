import { describe, expect, it } from "vitest";
import {
  automaticRealtimeModel,
  isRealtimeModelRejection,
  observeRealtimeModel,
} from "./realtime-model";

describe("Realtime Auto capability policy", () => {
  it.each([
    "chatgpt",
    "apiKey",
  ] as const)("keeps requested and effective model separate for %s", (auth) => {
    expect(automaticRealtimeModel("0.169.0", auth)).toMatchObject({
      policy: "server-default",
      requestedModel: null,
      effectiveModel: null,
      effectiveModelSource: "not-reported",
      authMode: auth,
      namedSelectionAvailable: false,
    });
    expect(automaticRealtimeModel("1.0.0", auth).requestedModel).toBeNull();
    for (const version of ["0.149.0", "0.168.9", null, "unknown", "0.169.0-preview"]) {
      expect(automaticRealtimeModel(version, auth)).toMatchObject({
        policy: "legacy-compatibility",
        requestedModel: "gpt-live-1-codex",
        effectiveModel: null,
      });
    }
  });

  it("only accepts an explicit session model report and never logs the rest of the session", () => {
    const model = automaticRealtimeModel("0.169.0", "chatgpt");
    for (const event of [
      {},
      { model: "gpt-live-1-codex" },
      { type: "thread/realtime/started", model: "x" },
      { type: "session.created", session: { model: "secret text with spaces" } },
      { type: "session.created", session: { model: "x".repeat(129) } },
    ]) {
      expect(observeRealtimeModel(model, event)).toBeNull();
    }
    const observed = observeRealtimeModel(model, {
      type: "session.created",
      session: {
        model: "server-reported-model",
        instructions: "PRIVATE INSTRUCTIONS",
        api_key: "PRIVATE KEY",
      },
    });
    expect(observed).toMatchObject({
      effectiveModel: "server-reported-model",
      outcome: "reported",
    });
    expect(JSON.stringify(observed)).not.toContain("PRIVATE");
    expect(
      observeRealtimeModel(automaticRealtimeModel("0.149.0", "chatgpt"), {
        type: "session.updated",
        session: { model: "different-model" },
      })?.outcome,
    ).toBe("different-from-request");
  });

  it("distinguishes model rejection from voice or authentication failures", () => {
    expect(isRealtimeModelRejection(new Error("Unknown parameter: session.model"))).toBe(true);
    expect(isRealtimeModelRejection(new Error("Model is not available"))).toBe(true);
    expect(isRealtimeModelRejection(new Error("Invalid voice"))).toBe(false);
    expect(isRealtimeModelRejection(new Error("Unauthorized"))).toBe(false);
  });
});
