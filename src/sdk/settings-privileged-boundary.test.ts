import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const settingsRoot = join(import.meta.dirname, "../../bundled-packs/ui/yorishiro-settings");

async function readSettingsSource(): Promise<string> {
  return readFile(join(settingsRoot, "ui.tsx"), "utf8");
}

function importedModuleIds(source: string): string[] {
  return Array.from(source.matchAll(/(?:from\s+|import\()["']([^"']+)["']/g), (match) => match[1])
    .filter((value): value is string => value !== undefined)
    .sort();
}

describe("system settings privileged boundary", () => {
  it("marks the bundled settings UI as trusted main-thread code", async () => {
    const manifest = JSON.parse(await readFile(join(settingsRoot, "manifest.json"), "utf8"));
    expect(manifest.executionClass).toBe("trusted-main-thread-js");
  });

  it("keeps raw Tauri and app-internal imports on the reviewed allowlist", async () => {
    const source = await readSettingsSource();
    const privilegedImports = importedModuleIds(source).filter(
      (moduleId) =>
        moduleId.startsWith("@tauri-apps/") ||
        moduleId.startsWith("../../../src/") ||
        moduleId === "../../scenes/simple-room/manifest.json",
    );

    expect(privilegedImports).toEqual([
      "../../../src/i18n/strings",
      "../../../src/runtime/history/describe-snapshot",
      "../../../src/runtime/language/language",
      "../../../src/runtime/updater/app-updater",
      "../../../src/runtime/user-pack-loader/config",
      "../../scenes/simple-room/manifest.json",
      "@tauri-apps/api/core",
      "@tauri-apps/plugin-dialog",
    ]);
  });

  it("uses raw invoke only for the reviewed system-owned VRM catalog/import commands", async () => {
    const source = await readSettingsSource();
    const invokedCommands = Array.from(
      source.matchAll(/\binvoke(?:<[^>]+>)?\(\s*["']([^"']+)["']/g),
      (match) => match[1],
    );
    expect(invokedCommands).toEqual(["list_vrm_avatars", "import_vrm"]);
  });

  it("uses public capabilities for generic app metadata, links, and history", async () => {
    const source = await readSettingsSource();

    expect(source).toMatch(/ctx\.app\s*\.\s*getVersion\(\)/);
    expect(source).toMatch(/ctx\.app\s*\.\s*openExternal\(/);
    expect(source).toMatch(/ctx\.history\s*\.\s*list\(\)/);
    expect(source).toMatch(/ctx\.history\s*\.\s*restore\(seq\)/);
    expect(source).not.toContain("src/bindings/");
    expect(source).not.toContain("src/components/");
    expect(source).not.toContain("src/sdk/");
  });
});
