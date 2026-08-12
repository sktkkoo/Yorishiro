import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const resource = (language: "en" | "ja", command: "create" | "help" | "update") =>
  new URL(
    `../../src-tauri/resources/yorishiro-plugin/commands-${language}/${command}.md`,
    import.meta.url,
  );

describe("Amenity service authoring guidance", () => {
  it.each([
    "en",
    "ja",
  ] as const)("routes %s Ambient UI authoring through the public service boundary", async (language) => {
    const [create, help, update] = await Promise.all([
      readFile(resource(language, "create"), "utf8"),
      readFile(resource(language, "help"), "utf8"),
      readFile(resource(language, "update"), "utf8"),
    ]);

    expect(create).toContain("AmenityHandle.service");
    expect(create).toContain("ctx.amenities");
    expect(create).toContain("getState()");
    expect(create).toContain("execute()");
    expect(create).toContain("globalThis");
    expect(create).toContain("pomodoro-ui");
    expect(help).toContain("ctx.amenities");
    expect(update).toContain("AmenityHandle.service");
    expect(update).toContain("ctx.amenities");
    expect(update).toContain("getState()");
    expect(update).toContain("execute(command, params?)");
    expect(update).toContain("globalThis");
    expect(update).toContain("pomodoro-ui");
  });
});
