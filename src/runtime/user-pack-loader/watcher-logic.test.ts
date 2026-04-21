/**
 * Tests for watcher pure logic — path parsing + event → action mapping。
 *
 * Tauri invoke / dynamic import が絡む handler side は integration 側でしか
 * test できないので、ここでは pure な分解結果のみを verify する。
 */

import { describe, expect, it } from "vitest";
import type { CharminalLayerEvent } from "./watcher-logic";
import { mapEventToAction, parseLayerPath } from "./watcher-logic";

const HOME = "/Users/sample/.charminal";

describe("parseLayerPath", () => {
  it("recognizes a supported pack kind inside packs/<id>/", () => {
    expect(parseLayerPath(`${HOME}/packs/my-effect/effect.js`, HOME)).toEqual({
      type: "pack",
      id: "my-effect",
      kind: "effect",
    });
    expect(parseLayerPath(`${HOME}/packs/my-persona/persona.js`, HOME)).toEqual({
      type: "pack",
      id: "my-persona",
      kind: "persona",
    });
    expect(parseLayerPath(`${HOME}/packs/my-ui/ui.tsx`, HOME)).toEqual({
      type: "pack",
      id: "my-ui",
      kind: "ui",
    });
    expect(parseLayerPath(`${HOME}/packs/my-ui/ui.js`, HOME)).toEqual({
      type: "pack",
      id: "my-ui",
      kind: "ui",
    });
  });

  it("recognizes init.js at the root", () => {
    expect(parseLayerPath(`${HOME}/init.js`, HOME)).toEqual({ type: "init" });
  });

  it("ignores paths outside ~/.charminal/", () => {
    expect(parseLayerPath("/tmp/elsewhere.js", HOME)).toEqual({ type: "ignore" });
  });

  it("ignores nested files deeper than packs/<id>/<kind>.js", () => {
    expect(parseLayerPath(`${HOME}/packs/my-effect/nested/deep.js`, HOME)).toEqual({
      type: "ignore",
    });
  });

  it("ignores non-.js files", () => {
    expect(parseLayerPath(`${HOME}/packs/my-effect/effect.ts`, HOME)).toEqual({ type: "ignore" });
    expect(parseLayerPath(`${HOME}/packs/my-effect/effect.tsx`, HOME)).toEqual({
      type: "ignore",
    });
    expect(parseLayerPath(`${HOME}/packs/my-effect/README.md`, HOME)).toEqual({ type: "ignore" });
  });

  it("ignores unsupported kinds (voice/body/scene) that the runtime has no registrar for", () => {
    expect(parseLayerPath(`${HOME}/packs/my-voice/voice.js`, HOME)).toEqual({ type: "ignore" });
    expect(parseLayerPath(`${HOME}/packs/my-body/body.js`, HOME)).toEqual({ type: "ignore" });
  });

  it("ignores the pack directory itself (packs/<id>)", () => {
    expect(parseLayerPath(`${HOME}/packs/my-effect`, HOME)).toEqual({ type: "ignore" });
  });

  it("ignores hidden pack dirs that start with a dot", () => {
    expect(parseLayerPath(`${HOME}/packs/.stash/effect.js`, HOME)).toEqual({ type: "ignore" });
  });

  it("tolerates a charminalHome that ends with a trailing slash", () => {
    expect(parseLayerPath(`${HOME}/packs/my-effect/effect.js`, `${HOME}/`)).toEqual({
      type: "pack",
      id: "my-effect",
      kind: "effect",
    });
  });
});

describe("mapEventToAction", () => {
  const effectEvent = (kind: CharminalLayerEvent["kind"]): CharminalLayerEvent => ({
    path: `${HOME}/packs/my-effect/effect.js`,
    kind,
    mtimeMs: 1700000000000,
  });

  it("maps a modified pack file to reload-pack carrying entryPath + mtime", () => {
    expect(mapEventToAction(effectEvent("modified"), HOME)).toEqual({
      type: "reload-pack",
      id: "my-effect",
      kind: "effect",
      entryPath: `${HOME}/packs/my-effect/effect.js`,
      mtimeMs: 1700000000000,
    });
  });

  it("maps a modified ui.tsx file to reload-pack", () => {
    expect(
      mapEventToAction(
        { path: `${HOME}/packs/my-ui/ui.tsx`, kind: "modified", mtimeMs: 1700000000001 },
        HOME,
      ),
    ).toEqual({
      type: "reload-pack",
      id: "my-ui",
      kind: "ui",
      entryPath: `${HOME}/packs/my-ui/ui.tsx`,
      mtimeMs: 1700000000001,
    });
  });

  it("maps a created pack file to reload-pack (first-time appearance)", () => {
    expect(mapEventToAction(effectEvent("created"), HOME)).toMatchObject({
      type: "reload-pack",
      id: "my-effect",
      kind: "effect",
    });
  });

  it("maps a removed pack file to remove-pack (no path needed)", () => {
    expect(mapEventToAction(effectEvent("removed"), HOME)).toEqual({
      type: "remove-pack",
      id: "my-effect",
      kind: "effect",
    });
  });

  it("maps init.js changes to init-changed regardless of event kind", () => {
    expect(
      mapEventToAction({ path: `${HOME}/init.js`, kind: "modified", mtimeMs: 12345 }, HOME),
    ).toEqual({ type: "init-changed", path: `${HOME}/init.js` });
  });

  it("maps unrelated paths to ignore", () => {
    expect(
      mapEventToAction({ path: `${HOME}/sdk.d.ts`, kind: "modified", mtimeMs: 0 }, HOME),
    ).toMatchObject({ type: "ignore" });
    expect(
      mapEventToAction({ path: "/var/log/syslog", kind: "modified", mtimeMs: 0 }, HOME),
    ).toMatchObject({ type: "ignore" });
  });
});
