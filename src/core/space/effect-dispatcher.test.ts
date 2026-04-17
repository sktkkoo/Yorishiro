import type { SpaceEffectRequest } from "@charminal/sdk";
import { describe, expect, it } from "vitest";
import { EffectDispatcher } from "./effect-dispatcher";

describe("EffectDispatcher", () => {
  it("returns a SpaceEffectHandle with the requested kind", () => {
    const dispatcher = new EffectDispatcher();
    const handle = dispatcher.dispatch({ kind: "shake", intensity: 0.5, durationMs: 300 });
    expect(handle.kind).toBe("shake");
  });

  it("delivers requests to subscribers matching kind", () => {
    const dispatcher = new EffectDispatcher();
    const seen: SpaceEffectRequest[] = [];
    dispatcher.subscribe("shake", (req) => seen.push(req));
    dispatcher.dispatch({ kind: "shake", intensity: 0.5, durationMs: 300 });
    expect(seen).toHaveLength(1);
    expect(seen[0].kind).toBe("shake");
  });

  it("ignores subscribers of different kind", () => {
    const dispatcher = new EffectDispatcher();
    const seen: SpaceEffectRequest[] = [];
    dispatcher.subscribe("flash", (req) => seen.push(req));
    dispatcher.dispatch({ kind: "shake", intensity: 0.5, durationMs: 300 });
    expect(seen).toHaveLength(0);
  });

  it("stops delivering after unsubscribe", () => {
    const dispatcher = new EffectDispatcher();
    const seen: SpaceEffectRequest[] = [];
    const unsubscribe = dispatcher.subscribe("shake", (req) => seen.push(req));
    unsubscribe();
    dispatcher.dispatch({ kind: "shake", intensity: 0.5, durationMs: 300 });
    expect(seen).toHaveLength(0);
  });

  it("supports multiple subscribers to the same kind", () => {
    const dispatcher = new EffectDispatcher();
    let a = 0;
    let b = 0;
    dispatcher.subscribe("shake", () => a++);
    dispatcher.subscribe("shake", () => b++);
    dispatcher.dispatch({ kind: "shake", intensity: 0.5, durationMs: 300 });
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});
