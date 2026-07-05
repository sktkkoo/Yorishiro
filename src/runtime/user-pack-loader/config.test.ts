/**
 * config.json の shape と pure 変換 helper のテスト。
 *
 * Tauri invoke を介した file I/O は test しない（stub できる value が無く、
 * production 側の dev-log で目視確認する——runtime-wire と同じ方針）。
 *
 * Internal design-record: 2026-04-19-persona-single-active.md（activePersonas → primaryPersona 差し替え）
 */

import { describe, expect, it } from "vitest";
import {
  type CharminalConfig,
  EMPTY_CONFIG,
  localizedClaiPersonaId,
  parseConfig,
  resolvePrimaryPersonaForLanguage,
  resolveSceneForProject,
  serializeConfig,
  withActiveAmbientUiSet,
  withActiveSceneSet,
  withActiveUiSet,
  withDisabledPackAdded,
  withDisabledPackRemoved,
  withLanguageSet,
  withPrimaryPersonaSet,
  withProjectSceneSet,
} from "./config";

describe("parseConfig", () => {
  it("returns EMPTY_CONFIG for empty input", () => {
    expect(parseConfig("")).toEqual(EMPTY_CONFIG);
  });

  it("returns EMPTY_CONFIG for malformed JSON", () => {
    expect(parseConfig("{ not json")).toEqual(EMPTY_CONFIG);
  });

  it("reads disabledPacks array", () => {
    const json = JSON.stringify({ disabledPacks: ["a", "b"] });
    expect(parseConfig(json)).toEqual({
      disabledPacks: ["a", "b"],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    });
  });

  it("reads primaryPersona string", () => {
    const json = JSON.stringify({ primaryPersona: "clai" });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: "clai",
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    });
  });

  it("treats empty string primaryPersona as null", () => {
    const json = JSON.stringify({ primaryPersona: "" });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    });
  });

  it("treats non-string primaryPersona as null", () => {
    const json = JSON.stringify({ primaryPersona: 42 });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    });
  });

  it("silently ignores legacy activePersonas field", () => {
    const json = JSON.stringify({ activePersonas: ["clai"] });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    });
  });

  it("reads mcpPort number", () => {
    const json = JSON.stringify({ mcpPort: 12345 });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: 12345,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    });
  });

  it("ignores unknown fields and unexpected types silently", () => {
    const json = JSON.stringify({
      disabledPacks: ["ok"],
      disabledPacksLegacy: "should be ignored",
      unknownField: 42,
      mcpPort: "not a number",
    });
    expect(parseConfig(json)).toEqual({
      disabledPacks: ["ok"],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    });
  });

  it("reads codex terminalAgent", () => {
    const config = parseConfig('{"terminalAgent": "codex"}');
    expect(config.terminalAgent).toBe("codex");
  });

  it("reads opencode terminalAgent", () => {
    const config = parseConfig('{"terminalAgent": "opencode"}');
    expect(config.terminalAgent).toBe("opencode");
  });

  it("defaults unknown terminalAgent to claude", () => {
    const config = parseConfig('{"terminalAgent": "unknown"}');
    expect(config.terminalAgent).toBe("claude");
  });

  it("reads tabMetadataBadges only when explicitly true", () => {
    expect(parseConfig("{}").tabMetadataBadges).toBe(false);
    expect(parseConfig('{"tabMetadataBadges": true}').tabMetadataBadges).toBe(true);
    expect(parseConfig('{"tabMetadataBadges": false}').tabMetadataBadges).toBe(false);
    expect(parseConfig('{"tabMetadataBadges": "true"}').tabMetadataBadges).toBe(false);
  });
});

describe("serializeConfig", () => {
  it("omits default arrays and null fields for minimal JSON", () => {
    const cfg: CharminalConfig = { ...EMPTY_CONFIG };
    const text = serializeConfig(cfg);
    expect(JSON.parse(text)).toEqual({});
  });

  it("writes disabledPacks when non-empty", () => {
    const cfg: CharminalConfig = {
      disabledPacks: ["a"],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ disabledPacks: ["a"] });
  });

  it("writes primaryPersona when set", () => {
    const cfg: CharminalConfig = {
      disabledPacks: [],
      primaryPersona: "my-persona",
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ primaryPersona: "my-persona" });
  });

  it("omits primaryPersona when null", () => {
    const cfg: CharminalConfig = { ...EMPTY_CONFIG, primaryPersona: null };
    expect(serializeConfig(cfg)).toBe("{}\n");
  });

  it("writes mcpPort when set", () => {
    const cfg: CharminalConfig = {
      ...EMPTY_CONFIG,
      mcpPort: 18743,
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ mcpPort: 18743 });
  });

  it("round-trips a populated config", () => {
    const cfg: CharminalConfig = {
      disabledPacks: ["a", "b"],
      primaryPersona: "my-persona",
      mcpPort: 18743,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "codex",
      ambientAudioMuted: true,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it("writes terminalAgent when codex is selected", () => {
    const cfg: CharminalConfig = { ...EMPTY_CONFIG, terminalAgent: "codex" };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ terminalAgent: "codex" });
  });

  it("writes terminalAgent when opencode is selected", () => {
    const cfg: CharminalConfig = { ...EMPTY_CONFIG, terminalAgent: "opencode" };
    const text = serializeConfig(cfg);
    expect(parseConfig(text).terminalAgent).toBe("opencode");
  });

  it("writes tabMetadataBadges only when enabled", () => {
    expect(JSON.parse(serializeConfig({ ...EMPTY_CONFIG }))).toEqual({});
    expect(JSON.parse(serializeConfig({ ...EMPTY_CONFIG, tabMetadataBadges: true }))).toEqual({
      tabMetadataBadges: true,
    });
  });
});

describe("motionIntensity", () => {
  it("defaults to 1.0", () => {
    expect(EMPTY_CONFIG.motionIntensity).toBe(1.0);
  });

  it("parses a number from JSON", () => {
    expect(parseConfig('{"motionIntensity": 2.5}').motionIntensity).toBe(2.5);
  });

  it("clamps above 3 to 3 and below 0 to 0", () => {
    expect(parseConfig('{"motionIntensity": 9}').motionIntensity).toBe(3);
    expect(parseConfig('{"motionIntensity": -2}').motionIntensity).toBe(0);
  });

  it("falls back to 1.0 for non-number", () => {
    expect(parseConfig('{"motionIntensity": "big"}').motionIntensity).toBe(1.0);
  });

  it("omits motionIntensity from serialized output when 1.0 (default)", () => {
    expect(JSON.parse(serializeConfig({ ...EMPTY_CONFIG }))).toEqual({});
  });

  it("writes motionIntensity when non-default", () => {
    const cfg = { ...EMPTY_CONFIG, motionIntensity: 2 };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ motionIntensity: 2 });
  });
});

describe("withDisabledPackAdded / withDisabledPackRemoved", () => {
  it("adds an id to disabledPacks", () => {
    const next = withDisabledPackAdded(EMPTY_CONFIG, "bad");
    expect(next.disabledPacks).toEqual(["bad"]);
  });

  it("is idempotent — adding the same id twice stays unique", () => {
    const once = withDisabledPackAdded(EMPTY_CONFIG, "x");
    const twice = withDisabledPackAdded(once, "x");
    expect(twice.disabledPacks).toEqual(["x"]);
  });

  it("removes an id from disabledPacks", () => {
    const base: CharminalConfig = {
      disabledPacks: ["a", "b"],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    };
    const next = withDisabledPackRemoved(base, "a");
    expect(next.disabledPacks).toEqual(["b"]);
  });

  it("is idempotent — removing an absent id is a no-op", () => {
    const base: CharminalConfig = {
      disabledPacks: ["a"],
      primaryPersona: null,
      mcpPort: null,
      activeScene: null,
      sceneByProject: {},
      activeUi: null,
      activeAmbientUi: ["attention-aura", "pomodoro-ui"],
      tabMetadataBadges: false,
      language: "auto",
      terminalAgent: "claude",
      ambientAudioMuted: false,
      ambientAudioVolume: 1,
      attentionLightNotifications: true,
      motionIntensity: 1,
      profiles: [],
      defaultProfile: null,
      voiceFrequency: "on",
      mediaFolders: ["~/Music"],
    };
    const next = withDisabledPackRemoved(base, "phantom");
    expect(next.disabledPacks).toEqual(["a"]);
  });
});

describe("activeScene", () => {
  it("parses string activeScene", () => {
    const cfg = parseConfig('{"activeScene": "my-scene"}');
    expect(cfg.activeScene).toBe("my-scene");
  });

  it("treats empty string activeScene as null", () => {
    const cfg = parseConfig('{"activeScene": ""}');
    expect(cfg.activeScene).toBeNull();
  });

  it("treats non-string activeScene as null", () => {
    const cfg = parseConfig('{"activeScene": 42}');
    expect(cfg.activeScene).toBeNull();
  });

  it("defaults to null when activeScene is absent", () => {
    const cfg = parseConfig("{}");
    expect(cfg.activeScene).toBeNull();
  });

  it("serializeConfig omits activeScene when null", () => {
    const cfg = { ...EMPTY_CONFIG, activeScene: null };
    expect(serializeConfig(cfg)).toBe("{}\n");
  });

  it("serializeConfig includes activeScene when set", () => {
    const cfg = { ...EMPTY_CONFIG, activeScene: "my-scene" };
    const parsed = JSON.parse(serializeConfig(cfg));
    expect(parsed.activeScene).toBe("my-scene");
  });
});

describe("sceneByProject", () => {
  it("parses string scene mappings and ignores unknown value types", () => {
    const cfg = parseConfig(
      JSON.stringify({
        sceneByProject: {
          "/repo/a": "forest",
          "/repo/b": "simple-room",
          "/repo/bad": 42,
          "/repo/empty": "",
        },
      }),
    );
    expect(cfg.sceneByProject).toEqual({
      "/repo/a": "forest",
      "/repo/b": "simple-room",
    });
  });

  it("defaults sceneByProject to an empty object", () => {
    expect(parseConfig("{}").sceneByProject).toEqual({});
  });

  it("omits sceneByProject when empty", () => {
    const cfg = { ...EMPTY_CONFIG, sceneByProject: {} };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({});
  });

  it("round-trips sceneByProject through serializeConfig", () => {
    const cfg = {
      ...EMPTY_CONFIG,
      activeScene: "fallback-room",
      sceneByProject: {
        "/repo/a": "factory",
        "/repo/b": "grasslands",
      },
    };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it("sets or clears a project-scene mapping immutably", () => {
    const added = withProjectSceneSet(EMPTY_CONFIG, "/repo/a", "factory");
    expect(added.sceneByProject).toEqual({ "/repo/a": "factory" });
    expect(EMPTY_CONFIG.sceneByProject).toEqual({});

    const removed = withProjectSceneSet(added, "/repo/a", null);
    expect(removed.sceneByProject).toEqual({});
  });
});

describe("resolveSceneForProject", () => {
  it("returns mapped scene for a project root hit", () => {
    const cfg = {
      ...EMPTY_CONFIG,
      activeScene: "fallback-room",
      sceneByProject: { "/repo/a": "factory" },
    };
    expect(resolveSceneForProject(cfg, "/repo/a")).toBe("factory");
  });

  it("falls back to activeScene when project root misses", () => {
    const cfg = {
      ...EMPTY_CONFIG,
      activeScene: "fallback-room",
      sceneByProject: { "/repo/a": "factory" },
    };
    expect(resolveSceneForProject(cfg, "/repo/b")).toBe("fallback-room");
  });

  it("falls back to activeScene when project root is null", () => {
    const cfg = {
      ...EMPTY_CONFIG,
      activeScene: "fallback-room",
      sceneByProject: { "/repo/a": "factory" },
    };
    expect(resolveSceneForProject(cfg, null)).toBe("fallback-room");
  });

  it("falls back to activeScene when parsed project mapping is empty", () => {
    const cfg = parseConfig(
      JSON.stringify({
        activeScene: "fallback-room",
        sceneByProject: { "/repo/a": "" },
      }),
    );
    expect(resolveSceneForProject(cfg, "/repo/a")).toBe("fallback-room");
  });

  it("returns null when neither mapping nor activeScene is set", () => {
    expect(resolveSceneForProject(EMPTY_CONFIG, "/repo/a")).toBeNull();
  });
});

describe("withActiveSceneSet", () => {
  it("sets activeScene to given id", () => {
    const next = withActiveSceneSet(EMPTY_CONFIG, "my-scene");
    expect(next.activeScene).toBe("my-scene");
  });

  it("clears activeScene when given null", () => {
    const cfg = { ...EMPTY_CONFIG, activeScene: "existing" };
    const next = withActiveSceneSet(cfg, null);
    expect(next.activeScene).toBeNull();
  });
});

describe("activeUi", () => {
  it("reads activeUi from config", () => {
    const config = parseConfig('{"activeUi": "camera-lighting-panel"}');
    expect(config.activeUi).toBe("camera-lighting-panel");
  });

  it("activeUi defaults to null for empty config", () => {
    const config = parseConfig("");
    expect(config.activeUi).toBeNull();
  });

  it("activeUi defaults to null for missing field", () => {
    const config = parseConfig('{"primaryPersona": "test"}');
    expect(config.activeUi).toBeNull();
  });

  it("serializeConfig includes activeUi when set", () => {
    const config = { ...EMPTY_CONFIG, activeUi: "my-ui" };
    const text = serializeConfig(config);
    expect(JSON.parse(text).activeUi).toBe("my-ui");
  });

  it("withActiveUiSet updates the field", () => {
    const updated = withActiveUiSet(EMPTY_CONFIG, "camera-lighting-panel");
    expect(updated.activeUi).toBe("camera-lighting-panel");
  });
});

describe("withPrimaryPersonaSet", () => {
  it("sets primaryPersona to given id", () => {
    const next = withPrimaryPersonaSet(EMPTY_CONFIG, "my-persona");
    expect(next.primaryPersona).toBe("my-persona");
  });

  it("clears primaryPersona when given null", () => {
    const cfg = { ...EMPTY_CONFIG, primaryPersona: "existing" };
    const next = withPrimaryPersonaSet(cfg, null);
    expect(next.primaryPersona).toBeNull();
  });
});

describe("localized CLAI persona defaults", () => {
  it("maps resolved language to the bundled CLAI persona id", () => {
    expect(localizedClaiPersonaId("en")).toBe("clai-en");
    expect(localizedClaiPersonaId("ja")).toBe("clai-ja");
  });

  it("uses localized CLAI when primaryPersona is unset", () => {
    expect(resolvePrimaryPersonaForLanguage(null, "en")).toBe("clai-en");
    expect(resolvePrimaryPersonaForLanguage(null, "ja")).toBe("clai-ja");
  });

  it("treats localized CLAI ids as language-following defaults", () => {
    expect(resolvePrimaryPersonaForLanguage("clai-en", "ja")).toBe("clai-ja");
    expect(resolvePrimaryPersonaForLanguage("clai-ja", "en")).toBe("clai-en");
  });

  it("preserves user-selected non-CLAI persona ids", () => {
    expect(resolvePrimaryPersonaForLanguage("my-persona", "ja")).toBe("my-persona");
  });
});

describe("activeAmbientUi", () => {
  it("defaults to ['attention-aura', 'pomodoro-ui']", () => {
    expect(EMPTY_CONFIG.activeAmbientUi).toEqual(["attention-aura", "pomodoro-ui"]);
  });

  it("parses array of strings from JSON", () => {
    const cfg = parseConfig(JSON.stringify({ activeAmbientUi: ["attention-aura", "my-overlay"] }));
    expect(cfg.activeAmbientUi).toEqual(["attention-aura", "my-overlay"]);
  });

  it("ignores non-string entries during parse", () => {
    const cfg = parseConfig(
      JSON.stringify({ activeAmbientUi: ["attention-aura", 42, null, "ok"] }),
    );
    expect(cfg.activeAmbientUi).toEqual(["attention-aura", "ok"]);
  });

  it("serializes back to array", () => {
    const cfg = { ...EMPTY_CONFIG, activeAmbientUi: ["a", "b"] };
    const out = JSON.parse(serializeConfig(cfg));
    expect(out.activeAmbientUi).toEqual(["a", "b"]);
  });

  it("serializes explicit empty array to keep Aura disabled", () => {
    const cfg = withActiveAmbientUiSet(EMPTY_CONFIG, []);
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ activeAmbientUi: [] });
    expect(parseConfig(serializeConfig(cfg)).activeAmbientUi).toEqual([]);
  });

  it("withActiveAmbientUiSet replaces the array", () => {
    const next = withActiveAmbientUiSet(EMPTY_CONFIG, ["x", "y"]);
    expect(next.activeAmbientUi).toEqual(["x", "y"]);
  });
});

describe("ambientAudioMuted", () => {
  it("defaults to false", () => {
    expect(EMPTY_CONFIG.ambientAudioMuted).toBe(false);
  });

  it("parses true from JSON", () => {
    expect(parseConfig('{"ambientAudioMuted": true}').ambientAudioMuted).toBe(true);
  });

  it("parses false from JSON", () => {
    expect(parseConfig('{"ambientAudioMuted": false}').ambientAudioMuted).toBe(false);
  });

  it("treats non-boolean as false", () => {
    expect(parseConfig('{"ambientAudioMuted": "true"}').ambientAudioMuted).toBe(false);
    expect(parseConfig('{"ambientAudioMuted": 1}').ambientAudioMuted).toBe(false);
  });

  it("omits ambientAudioMuted from serialized output when false (default)", () => {
    const cfg = { ...EMPTY_CONFIG };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({});
  });

  it("writes ambientAudioMuted when true", () => {
    const cfg = { ...EMPTY_CONFIG, ambientAudioMuted: true };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ ambientAudioMuted: true });
  });
});

describe("attentionLightNotifications", () => {
  it("defaults to true", () => {
    expect(EMPTY_CONFIG.attentionLightNotifications).toBe(true);
    expect(parseConfig("{}").attentionLightNotifications).toBe(true);
  });

  it("parses false only when explicitly disabled", () => {
    expect(parseConfig('{"attentionLightNotifications": false}').attentionLightNotifications).toBe(
      false,
    );
    expect(parseConfig('{"attentionLightNotifications": true}').attentionLightNotifications).toBe(
      true,
    );
    expect(
      parseConfig('{"attentionLightNotifications": "false"}').attentionLightNotifications,
    ).toBe(true);
  });

  it("omits the default true value from serialized output", () => {
    expect(JSON.parse(serializeConfig({ ...EMPTY_CONFIG }))).toEqual({});
  });

  it("writes attentionLightNotifications only when disabled", () => {
    const cfg = { ...EMPTY_CONFIG, attentionLightNotifications: false };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ attentionLightNotifications: false });
  });
});

describe("profiles[]", () => {
  it("defaults to empty array", () => {
    expect(EMPTY_CONFIG.profiles).toEqual([]);
  });

  it("parses a minimal shell profile", () => {
    const cfg = parseConfig(JSON.stringify({ profiles: [{ id: "shell-fish", kind: "shell" }] }));
    expect(cfg.profiles).toEqual([
      {
        id: "shell-fish",
        kind: "shell",
        command: null,
        args: [],
        env: {},
        cwd: null,
        agent: null,
        integration: true,
      },
    ]);
  });

  it("parses an agent profile with all optional fields", () => {
    const cfg = parseConfig(
      JSON.stringify({
        profiles: [
          {
            id: "claude-debug",
            kind: "agent",
            agent: "claude",
            command: "claude",
            args: ["--debug"],
            env: { LOG_LEVEL: "trace" },
            cwd: "/tmp/proj",
            integration: false,
          },
        ],
      }),
    );
    expect(cfg.profiles[0]).toEqual({
      id: "claude-debug",
      kind: "agent",
      agent: "claude",
      command: "claude",
      args: ["--debug"],
      env: { LOG_LEVEL: "trace" },
      cwd: "/tmp/proj",
      integration: false,
    });
  });

  it("skips profile entry missing id", () => {
    const cfg = parseConfig(JSON.stringify({ profiles: [{ kind: "shell" }] }));
    expect(cfg.profiles).toEqual([]);
  });

  it("skips profile entry with unknown kind", () => {
    const cfg = parseConfig(JSON.stringify({ profiles: [{ id: "x", kind: "wormhole" }] }));
    expect(cfg.profiles).toEqual([]);
  });

  it("skips agent profile missing agent field", () => {
    const cfg = parseConfig(JSON.stringify({ profiles: [{ id: "x", kind: "agent" }] }));
    expect(cfg.profiles).toEqual([]);
  });

  it("accepts agent profile with opencode", () => {
    const cfg = parseConfig(
      JSON.stringify({
        profiles: [{ id: "my-opencode", kind: "agent", agent: "opencode" }],
      }),
    );
    expect(cfg.profiles).toHaveLength(1);
    expect(cfg.profiles[0]?.agent).toBe("opencode");
  });

  it("filters out invalid entries while keeping valid ones", () => {
    const cfg = parseConfig(
      JSON.stringify({
        profiles: [
          { id: "good", kind: "shell" },
          { kind: "shell" }, // missing id
          { id: "also-good", kind: "agent", agent: "codex" },
          "not an object",
        ],
      }),
    );
    expect(cfg.profiles.map((p) => p.id)).toEqual(["good", "also-good"]);
  });

  it("ignores non-string env values", () => {
    const cfg = parseConfig(
      JSON.stringify({
        profiles: [
          {
            id: "x",
            kind: "shell",
            env: { OK: "ok", NUMERIC: 42, NULLISH: null },
          },
        ],
      }),
    );
    expect(cfg.profiles[0].env).toEqual({ OK: "ok" });
  });

  it("treats kind=shell with agent field as agent=null", () => {
    const cfg = parseConfig(
      JSON.stringify({
        profiles: [{ id: "x", kind: "shell", agent: "claude" }],
      }),
    );
    expect(cfg.profiles[0].agent).toBeNull();
  });

  it("serializes minimal profile (omits default fields)", () => {
    const cfg = {
      ...EMPTY_CONFIG,
      profiles: [
        {
          id: "shell-fish",
          kind: "shell" as const,
          command: null,
          args: [],
          env: {},
          cwd: null,
          agent: null,
          integration: true,
        },
      ],
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({
      profiles: [{ id: "shell-fish", kind: "shell" }],
    });
  });

  it("round-trips a profile with all fields populated", () => {
    const cfg: CharminalConfig = {
      ...EMPTY_CONFIG,
      profiles: [
        {
          id: "nix-dev",
          kind: "shell",
          command: "nix-shell",
          args: ["--command", "zsh"],
          env: { NIX_PATH: "/nix" },
          cwd: "~/projects",
          agent: null,
          integration: false,
        },
      ],
    };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it("omits profiles field when array is empty", () => {
    const cfg = { ...EMPTY_CONFIG, profiles: [] };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({});
  });
});

describe("defaultProfile", () => {
  it("defaults to null", () => {
    expect(EMPTY_CONFIG.defaultProfile).toBeNull();
  });

  it("parses string defaultProfile", () => {
    const cfg = parseConfig(JSON.stringify({ defaultProfile: "shell" }));
    expect(cfg.defaultProfile).toBe("shell");
  });

  it("treats empty string as null", () => {
    const cfg = parseConfig(JSON.stringify({ defaultProfile: "" }));
    expect(cfg.defaultProfile).toBeNull();
  });

  it("treats non-string as null", () => {
    const cfg = parseConfig(JSON.stringify({ defaultProfile: 42 }));
    expect(cfg.defaultProfile).toBeNull();
  });

  it("serializes when set", () => {
    const cfg = { ...EMPTY_CONFIG, defaultProfile: "shell" };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ defaultProfile: "shell" });
  });

  it("omits defaultProfile from output when null", () => {
    const cfg = { ...EMPTY_CONFIG, defaultProfile: null };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({});
  });

  it("round-trips when set", () => {
    const cfg = { ...EMPTY_CONFIG, defaultProfile: "shell" };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });
});

describe("language", () => {
  it("defaults to auto", () => {
    expect(EMPTY_CONFIG.language).toBe("auto");
    expect(parseConfig("").language).toBe("auto");
  });

  it("parses supported language values", () => {
    expect(parseConfig('{"language":"auto"}').language).toBe("auto");
    expect(parseConfig('{"language":"en"}').language).toBe("en");
    expect(parseConfig('{"language":"ja"}').language).toBe("ja");
  });

  it("falls back to auto for unsupported language values", () => {
    expect(parseConfig('{"language":"fr"}').language).toBe("auto");
    expect(parseConfig('{"language":42}').language).toBe("auto");
  });

  it("omits auto from serialized output", () => {
    const cfg = { ...EMPTY_CONFIG, language: "auto" as const };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({});
  });

  it("serializes explicit language", () => {
    const cfg = { ...EMPTY_CONFIG, language: "en" as const };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ language: "en" });
  });

  it("sets language immutably", () => {
    const next = withLanguageSet(EMPTY_CONFIG, "ja");
    expect(next.language).toBe("ja");
    expect(EMPTY_CONFIG.language).toBe("auto");
  });
});
