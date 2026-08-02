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
  EMPTY_CONFIG,
  listCodexRealtimeVoiceCandidatesForPersona,
  localizedYoriPersonaId,
  parseConfig,
  resolveCodexRealtimeVoiceForPersona,
  resolvePrimaryPersonaForLanguage,
  resolveProjectFolder,
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
  type YorishiroConfig,
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
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    });
  });

  it("reads primaryPersona string", () => {
    const json = JSON.stringify({ primaryPersona: "yori" });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: "yori",
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    });
  });

  it("treats empty string primaryPersona as null", () => {
    const json = JSON.stringify({ primaryPersona: "" });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    });
  });

  it("treats non-string primaryPersona as null", () => {
    const json = JSON.stringify({ primaryPersona: 42 });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    });
  });

  it("silently ignores legacy activePersonas field", () => {
    const json = JSON.stringify({ activePersonas: ["yori"] });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    });
  });

  it("reads mcpPort number", () => {
    const json = JSON.stringify({ mcpPort: 12345 });
    expect(parseConfig(json)).toEqual({
      disabledPacks: [],
      primaryPersona: null,
      mcpPort: 12345,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
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
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
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
    const cfg: YorishiroConfig = { ...EMPTY_CONFIG };
    const text = serializeConfig(cfg);
    expect(JSON.parse(text)).toEqual({});
  });

  it("writes disabledPacks when non-empty", () => {
    const cfg: YorishiroConfig = {
      disabledPacks: ["a"],
      primaryPersona: null,
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ disabledPacks: ["a"] });
  });

  it("writes primaryPersona when set", () => {
    const cfg: YorishiroConfig = {
      disabledPacks: [],
      primaryPersona: "my-persona",
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ primaryPersona: "my-persona" });
  });

  it("omits primaryPersona when null", () => {
    const cfg: YorishiroConfig = { ...EMPTY_CONFIG, primaryPersona: null };
    expect(serializeConfig(cfg)).toBe("{}\n");
  });

  it("writes mcpPort when set", () => {
    const cfg: YorishiroConfig = {
      ...EMPTY_CONFIG,
      mcpPort: 18743,
    };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ mcpPort: 18743 });
  });

  it("round-trips a populated config", () => {
    const cfg: YorishiroConfig = {
      disabledPacks: ["a", "b"],
      primaryPersona: "my-persona",
      mcpPort: 18743,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    };
    expect(parseConfig(serializeConfig(cfg))).toEqual(cfg);
  });

  it("writes terminalAgent when codex is selected", () => {
    const cfg: YorishiroConfig = { ...EMPTY_CONFIG, terminalAgent: "codex" };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ terminalAgent: "codex" });
  });

  it("writes terminalAgent when opencode is selected", () => {
    const cfg: YorishiroConfig = { ...EMPTY_CONFIG, terminalAgent: "opencode" };
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

describe("codexRealtimeVoice", () => {
  it("defaults invalid values to sol", () => {
    expect(parseConfig("{}").codexRealtimeVoice).toBe("sol");
    expect(parseConfig('{"codexRealtimeVoice":""}').codexRealtimeVoice).toBe("sol");
    expect(parseConfig('{"codexRealtimeVoice":42}').codexRealtimeVoice).toBe("sol");
  });

  it("trims and preserves a configured voice", () => {
    expect(parseConfig('{"codexRealtimeVoice":"  juniper  "}').codexRealtimeVoice).toBe("juniper");
  });

  it("omits sol and serializes a non-default voice", () => {
    expect(JSON.parse(serializeConfig({ ...EMPTY_CONFIG }))).toEqual({});
    expect(JSON.parse(serializeConfig({ ...EMPTY_CONFIG, codexRealtimeVoice: "maple" }))).toEqual({
      codexRealtimeVoice: "maple",
    });
  });

  it("marks a configured voice as explicit, including an explicit sol", () => {
    expect(parseConfig("{}").codexRealtimeVoiceExplicit).toBe(false);
    expect(parseConfig('{"codexRealtimeVoice":""}').codexRealtimeVoiceExplicit).toBe(false);
    expect(parseConfig('{"codexRealtimeVoice":42}').codexRealtimeVoiceExplicit).toBe(false);
    expect(parseConfig('{"codexRealtimeVoice":"sol"}').codexRealtimeVoiceExplicit).toBe(true);
    expect(parseConfig('{"codexRealtimeVoice":"  sol  "}').codexRealtimeVoiceExplicit).toBe(true);
    expect(parseConfig('{"codexRealtimeVoice":"juniper"}').codexRealtimeVoiceExplicit).toBe(true);
  });

  it("does not serialize the derived explicit flag", () => {
    const explicitSol = parseConfig('{"codexRealtimeVoice":"sol"}');
    expect(explicitSol.codexRealtimeVoiceExplicit).toBe(true);
    expect(JSON.parse(serializeConfig(explicitSol))).toEqual({});
  });
});

describe("realtimeVoiceByPersona", () => {
  it("defaults to empty mapping", () => {
    expect(EMPTY_CONFIG.realtimeVoiceByPersona).toEqual({});
    expect(parseConfig("{}").realtimeVoiceByPersona).toEqual({});
  });

  it("parses persona id → voice entries and trims voice values", () => {
    const json = JSON.stringify({
      realtimeVoiceByPersona: { "yori-ja": "  maple  ", "my-persona": "juniper" },
    });
    expect(parseConfig(json).realtimeVoiceByPersona).toEqual({
      "yori-ja": "maple",
      "my-persona": "juniper",
    });
  });

  it("drops invalid entries without failing the rest", () => {
    const json = JSON.stringify({
      realtimeVoiceByPersona: {
        "yori-ja": "maple",
        "bad-number": 42,
        "bad-empty": "   ",
        "  ": "vale",
      },
    });
    expect(parseConfig(json).realtimeVoiceByPersona).toEqual({ "yori-ja": "maple" });
  });

  it("tolerates non-object shapes", () => {
    expect(parseConfig('{"realtimeVoiceByPersona": null}').realtimeVoiceByPersona).toEqual({});
    expect(parseConfig('{"realtimeVoiceByPersona": ["maple"]}').realtimeVoiceByPersona).toEqual({});
    expect(parseConfig('{"realtimeVoiceByPersona": "maple"}').realtimeVoiceByPersona).toEqual({});
  });

  it("omits empty mapping and round-trips non-empty mapping", () => {
    expect(JSON.parse(serializeConfig({ ...EMPTY_CONFIG }))).toEqual({});
    const cfg = { ...EMPTY_CONFIG, realtimeVoiceByPersona: { "yori-ja": "maple" } };
    const serialized = serializeConfig(cfg);
    expect(JSON.parse(serialized)).toEqual({ realtimeVoiceByPersona: { "yori-ja": "maple" } });
    expect(parseConfig(serialized).realtimeVoiceByPersona).toEqual({ "yori-ja": "maple" });
  });

  it("drops a __proto__ entry instead of touching the prototype", () => {
    const parsed = parseConfig('{"realtimeVoiceByPersona":{"__proto__":"maple","yori-ja":"vale"}}');
    expect(parsed.realtimeVoiceByPersona).toEqual({ "yori-ja": "vale" });
    expect(Object.getOwnPropertyDescriptor(parsed.realtimeVoiceByPersona, "__proto__")).toBe(
      undefined,
    );
    expect(Object.getPrototypeOf(parsed.realtimeVoiceByPersona)).toBe(Object.prototype);
  });
});

describe("resolveCodexRealtimeVoiceForPersona", () => {
  const cfg = (overrides: Partial<YorishiroConfig>): YorishiroConfig => ({
    ...EMPTY_CONFIG,
    ...overrides,
  });

  it("prefers the persona override over the global voice", () => {
    const resolved = resolveCodexRealtimeVoiceForPersona(
      cfg({
        codexRealtimeVoice: "juniper",
        realtimeVoiceByPersona: { "yori-ja": "maple" },
      }),
      "yori-ja",
    );
    expect(resolved).toEqual({ voice: "maple", source: "persona", personaId: "yori-ja" });
  });

  it("falls back to the global voice when the persona has no entry", () => {
    const resolved = resolveCodexRealtimeVoiceForPersona(
      cfg({
        codexRealtimeVoice: "juniper",
        realtimeVoiceByPersona: { "other-persona": "maple" },
      }),
      "yori-ja",
    );
    expect(resolved).toEqual({ voice: "juniper", source: "global", personaId: "yori-ja" });
  });

  it("falls back to the built-in default when nothing is configured", () => {
    const resolved = resolveCodexRealtimeVoiceForPersona(cfg({}), "yori-ja");
    expect(resolved).toEqual({ voice: "sol", source: "default", personaId: "yori-ja" });
  });

  it("skips persona overrides when the active persona id is unknown", () => {
    const resolved = resolveCodexRealtimeVoiceForPersona(
      cfg({ realtimeVoiceByPersona: { "yori-ja": "maple" } }),
      null,
    );
    expect(resolved).toEqual({ voice: "sol", source: "default", personaId: null });
  });

  it("keeps entries for removed personas inert", () => {
    // persona pack を削除 / rename しても mapping は残ってよい。
    // 該当 id が active にならない限り解決に影響しない。
    const resolved = resolveCodexRealtimeVoiceForPersona(
      cfg({
        codexRealtimeVoice: "juniper",
        realtimeVoiceByPersona: { "removed-persona": "maple" },
      }),
      "current-persona",
    );
    expect(resolved).toEqual({ voice: "juniper", source: "global", personaId: "current-persona" });
  });

  it("resolves per localized bundled persona id", () => {
    // bundled Yori は language で yori-en / yori-ja に解決されるため、
    // override も localized id 単位で効く。
    const config = cfg({ realtimeVoiceByPersona: { "yori-ja": "maple" } });
    expect(resolveCodexRealtimeVoiceForPersona(config, "yori-ja").voice).toBe("maple");
    expect(resolveCodexRealtimeVoiceForPersona(config, "yori-en")).toEqual({
      voice: "sol",
      source: "default",
      personaId: "yori-en",
    });
  });

  it("follows the bundled language fallback to the localized persona id", () => {
    // primaryPersona が null / bundled Yori のとき active id は language で決まる。
    // その解決結果に対して override が引かれることを、二層をつないで確認する。
    const config = cfg({
      primaryPersona: null,
      realtimeVoiceByPersona: { "yori-ja": "maple", "yori-en": "vale" },
    });
    const jaPersona = resolvePrimaryPersonaForLanguage(config.primaryPersona, "ja");
    const enPersona = resolvePrimaryPersonaForLanguage(config.primaryPersona, "en");
    expect(jaPersona).toBe("yori-ja");
    expect(enPersona).toBe("yori-en");
    expect(resolveCodexRealtimeVoiceForPersona(config, jaPersona).voice).toBe("maple");
    expect(resolveCodexRealtimeVoiceForPersona(config, enPersona).voice).toBe("vale");
  });

  it("diagnoses an explicitly configured sol as source=global", () => {
    const parsed = parseConfig('{"codexRealtimeVoice":"sol"}');
    expect(resolveCodexRealtimeVoiceForPersona(parsed, "yori-ja")).toEqual({
      voice: "sol",
      source: "global",
      personaId: "yori-ja",
    });
    // 未設定なら従来どおり default と診断する。
    expect(resolveCodexRealtimeVoiceForPersona(parseConfig("{}"), "yori-ja").source).toBe(
      "default",
    );
  });

  it("ignores prototype-inherited keys when looking up a persona override", () => {
    // persona id が constructor / toString / __proto__ でも、mapping の own entry
    // でない限り prototype 由来の値を voice として拾わない。
    const config = cfg({ realtimeVoiceByPersona: {} });
    for (const personaId of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
      expect(resolveCodexRealtimeVoiceForPersona(config, personaId)).toEqual({
        voice: "sol",
        source: "default",
        personaId,
      });
    }
    // own entry として明示された危険風 id は普通の persona id として尊重する。
    const parsed = parseConfig('{"realtimeVoiceByPersona":{"constructor":"maple"}}');
    expect(resolveCodexRealtimeVoiceForPersona(parsed, "constructor").voice).toBe("maple");
  });
});

describe("listCodexRealtimeVoiceCandidatesForPersona", () => {
  const cfg = (overrides: Partial<YorishiroConfig>): YorishiroConfig => ({
    ...EMPTY_CONFIG,
    ...overrides,
  });

  it("orders candidates persona → global → default", () => {
    const candidates = listCodexRealtimeVoiceCandidatesForPersona(
      cfg({
        codexRealtimeVoice: "juniper",
        realtimeVoiceByPersona: { "yori-ja": "maple" },
      }),
      "yori-ja",
    );
    expect(candidates).toEqual([
      { voice: "maple", source: "persona", personaId: "yori-ja" },
      { voice: "juniper", source: "global", personaId: "yori-ja" },
      { voice: "sol", source: "default", personaId: "yori-ja" },
    ]);
  });

  it("dedupes the same voice across layers keeping the higher-priority source", () => {
    const candidates = listCodexRealtimeVoiceCandidatesForPersona(
      cfg({
        codexRealtimeVoice: "maple",
        realtimeVoiceByPersona: { "yori-ja": "maple" },
      }),
      "yori-ja",
    );
    expect(candidates).toEqual([
      { voice: "maple", source: "persona", personaId: "yori-ja" },
      { voice: "sol", source: "default", personaId: "yori-ja" },
    ]);
  });

  it("collapses an explicit sol into a single global candidate", () => {
    const candidates = listCodexRealtimeVoiceCandidatesForPersona(
      parseConfig('{"codexRealtimeVoice":"sol"}'),
      null,
    );
    expect(candidates).toEqual([{ voice: "sol", source: "global", personaId: null }]);
  });

  it("returns only the default when nothing is configured", () => {
    expect(listCodexRealtimeVoiceCandidatesForPersona(cfg({}), null)).toEqual([
      { voice: "sol", source: "default", personaId: null },
    ]);
  });

  it("matches resolveCodexRealtimeVoiceForPersona at the head", () => {
    const config = parseConfig(
      '{"codexRealtimeVoice":"juniper","realtimeVoiceByPersona":{"yori-ja":"maple"}}',
    );
    for (const personaId of ["yori-ja", "yori-en", null]) {
      expect(listCodexRealtimeVoiceCandidatesForPersona(config, personaId)[0]).toEqual(
        resolveCodexRealtimeVoiceForPersona(config, personaId),
      );
    }
  });
});

describe("projectFolder", () => {
  it("defaults to null", () => {
    expect(EMPTY_CONFIG.projectFolder).toBeNull();
    expect(parseConfig("{}").projectFolder).toBeNull();
  });

  it("parses string projectFolder", () => {
    expect(parseConfig('{"projectFolder": "/Users/alice/Charminal"}').projectFolder).toBe(
      "/Users/alice/Charminal",
    );
  });

  it("treats empty projectFolder as null", () => {
    expect(parseConfig('{"projectFolder": ""}').projectFolder).toBeNull();
  });

  it("serializes projectFolder when set", () => {
    const cfg = { ...EMPTY_CONFIG, projectFolder: "~/Charminal" };
    expect(JSON.parse(serializeConfig(cfg))).toEqual({ projectFolder: "~/Charminal" });
  });

  it("resolves projectFolder before fallback", () => {
    expect(resolveProjectFolder("~/Charminal", "/tmp/fallback", "/Users/alice")).toBe(
      "/Users/alice/Charminal",
    );
  });

  it("falls back when projectFolder is not set", () => {
    expect(resolveProjectFolder(null, "/tmp/fallback", "/Users/alice")).toBe("/tmp/fallback");
  });

  it("does not return unresolved tilde paths without home", () => {
    expect(resolveProjectFolder("~/Charminal", "/tmp/fallback", null)).toBeNull();
    expect(resolveProjectFolder("~", "/tmp/fallback", null)).toBeNull();
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
    const base: YorishiroConfig = {
      disabledPacks: ["a", "b"],
      primaryPersona: null,
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
      mediaFolders: ["~/Music"],
    };
    const next = withDisabledPackRemoved(base, "a");
    expect(next.disabledPacks).toEqual(["b"]);
  });

  it("is idempotent — removing an absent id is a no-op", () => {
    const base: YorishiroConfig = {
      disabledPacks: ["a"],
      primaryPersona: null,
      mcpPort: null,
      projectFolder: null,
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
      codexRealtimeVoice: "sol",
      codexRealtimeVoiceExplicit: false,
      realtimeVoiceByPersona: {},
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

describe("localized Yori persona defaults", () => {
  it("maps resolved language to the bundled Yori persona id", () => {
    expect(localizedYoriPersonaId("en")).toBe("yori-en");
    expect(localizedYoriPersonaId("ja")).toBe("yori-ja");
  });

  it("uses localized Yori when primaryPersona is unset", () => {
    expect(resolvePrimaryPersonaForLanguage(null, "en")).toBe("yori-en");
    expect(resolvePrimaryPersonaForLanguage(null, "ja")).toBe("yori-ja");
  });

  it("treats localized Yori ids as language-following defaults", () => {
    expect(resolvePrimaryPersonaForLanguage("yori-en", "ja")).toBe("yori-ja");
    expect(resolvePrimaryPersonaForLanguage("yori-ja", "en")).toBe("yori-en");
  });

  it("preserves user-selected non-Yori persona ids", () => {
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
    const cfg: YorishiroConfig = {
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
