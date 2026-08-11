import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const bundledScenesRoot = join(import.meta.dirname, "../../bundled-packs/scenes");
const attentionCueScenes = ["abandoned-factory", "misty-grasslands", "simple-room"] as const;

describe("bundled attention cue authoring contract", () => {
  it.each(attentionCueScenes)("%s uses the same public SDK entry as local scenes", async (id) => {
    const source = await readFile(join(bundledScenesRoot, id, "scene.tsx"), "utf8");

    expect(source).toContain('from "@yorishiro/sdk/attention-cue"');
    expect(source).not.toContain("src/runtime/three-runtime/attention-cue-light");
  });
});
