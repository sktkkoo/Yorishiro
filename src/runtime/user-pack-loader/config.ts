/**
 * `~/.charminal/config.json` の shape と pure 変換 helper。
 *
 * File I/O は runtime-wire.ts が Tauri command 経由で組む。この module は
 * parse / serialize / field mutation を pure fn として閉じ込め、test 可能
 * な境界を作る。
 *
 * Schema:
 * - `disabledPacks: string[]`（optional）: rescue 用の flag 群
 * - `primaryPersona: string | null`（optional）: user が explicit に picks した persona pack の id
 * - `mcpPort: number`（optional）: MCP server の port override
 * - `activeScene: string | null`（optional）: user が explicit に picks した scene pack の id
 * - `activeUi: string | null`（optional）: user が explicit に picks した UI pack の id
 * - `activeAmbientUi: string[]`（optional）: 同時有効化される ambient-ui pack の id 一覧
 * - `language: "auto" | "en" | "ja"`（optional）: UI / persona fallback / command prompt の言語
 * - `terminalAgent: string`（optional）: legacy。`defaultProfile` 未指定時の fallback として使われる
 * - `ambientAudioMuted: boolean`（optional）: scene pack の環境音を mute する
 * - `profiles: SessionProfile[]`（optional）: user 定義の session profile 一覧
 * - `defaultProfile: string | null`（optional）: 起動時 default-session に使う profile id。bundled (`shell` / `claude` / `codex` / `opencode`) または user `profiles[]` の id。null なら `terminalAgent` を fallback に使う
 *
 * Migration note: 旧 `activePersonas` field は parseConfig で silently ignored
 * （YAGNI — user の既存 config は新規 field が無いだけで壊れない）。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-19-persona-single-active.md /
 *                         2026-05-05-multi-pane-terminal.md（profiles[]）
 */

import {
  type AppLanguage,
  DEFAULT_LANGUAGE,
  type ResolvedLanguage,
  toAppLanguage,
} from "../language/language";
import type { SessionProfile } from "../sessions/types";

export interface CharminalConfig {
  readonly disabledPacks: ReadonlyArray<string>;
  /** User が explicit に picks した persona pack の id。null なら bundled alphabetical default に fall through。 */
  readonly primaryPersona: string | null;
  readonly mcpPort: number | null;
  /** User が explicit に picks した scene pack の id。null / undefined なら bundled alphabetical default に fall through。 */
  readonly activeScene: string | null;
  /** User が explicit に picks した UI pack の id。null なら UI pack なし。 */
  readonly activeUi: string | null;
  /** 同時有効化される ambient-ui pack の id 一覧。複数 active 可。 */
  readonly activeAmbientUi: ReadonlyArray<string>;
  /** UI / persona fallback / command prompt の言語。`auto` なら起動時 locale から解決する。 */
  readonly language: AppLanguage;
  /** Terminal で自動起動する coding agent。未指定なら Claude Code。 */
  readonly terminalAgent: TerminalAgent;
  /** Scene pack の `ambient` 宣言で再生される環境音を mute する。 */
  readonly ambientAudioMuted: boolean;
  /** 環境音のマスターボリューム（0.0-1.0）。全 Howl の volume にこの値を乗算する。 */
  readonly ambientAudioVolume: number;
  /** User 定義の session profile。bundled (`shell` / `claude` / `codex` / `opencode`) と同 id なら override。 */
  readonly profiles: ReadonlyArray<SessionProfile>;
  /** 起動時 default-session に使う profile id。null なら `terminalAgent` を fallback。 */
  readonly defaultProfile: string | null;
  /** TTS 音声の利用頻度。 */
  readonly voiceFrequency: VoiceFrequency;
}

export type TerminalAgent = string;

/** Voice Summary の On/Off。"on" は毎回発話、"off" は voice_say を使わない（token 消費なし）。 */
export type VoiceFrequency = "on" | "off";

const BUNDLED_CLAI_PERSONA_IDS = new Set(["clai-en", "clai-ja"]);

export const EMPTY_CONFIG: CharminalConfig = {
  disabledPacks: [],
  primaryPersona: null,
  mcpPort: null,
  activeScene: null,
  activeUi: null,
  activeAmbientUi: ["attention-aura", "pomodoro-ui"],
  language: DEFAULT_LANGUAGE,
  terminalAgent: "claude",
  ambientAudioMuted: false,
  ambientAudioVolume: 1.0,
  profiles: [],
  defaultProfile: null,
  voiceFrequency: "on",
};

export function localizedClaiPersonaId(language: ResolvedLanguage): "clai-en" | "clai-ja" {
  return language === "ja" ? "clai-ja" : "clai-en";
}

export function isBundledClaiPersonaId(id: string | null): boolean {
  return id !== null && BUNDLED_CLAI_PERSONA_IDS.has(id);
}

export function resolvePrimaryPersonaForLanguage(
  primaryPersona: string | null,
  language: ResolvedLanguage,
): string {
  return primaryPersona === null || isBundledClaiPersonaId(primaryPersona)
    ? localizedClaiPersonaId(language)
    : primaryPersona;
}

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
};

const stringArraysEqual = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean => {
  return a.length === b.length && a.every((value, index) => value === b[index]);
};

const toPort = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const toNullableString = (value: unknown): string | null => {
  return typeof value === "string" && value !== "" ? value : null;
};

export const KNOWN_AGENT_IDS: ReadonlySet<string> = new Set(["claude", "codex", "opencode"]);

const toTerminalAgent = (value: unknown): TerminalAgent => {
  if (typeof value === "string" && KNOWN_AGENT_IDS.has(value)) {
    return value;
  }
  return "claude";
};

const toBoolean = (value: unknown): boolean => {
  return value === true;
};

const toVoiceFrequency = (value: unknown): VoiceFrequency => {
  if (value === "off" || value === "none") return "off";
  return "on";
};

/** 0.0-1.0 の float を返す。無効値は 1.0（default）に fallback。 */
const toUnitFloat = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1.0;
  return Math.max(0, Math.min(1, value));
};

const toStringRecord = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === "string") result[k] = v;
  }
  return result;
};

const toSessionAgent = (value: unknown): string | null => {
  if (typeof value === "string" && KNOWN_AGENT_IDS.has(value)) {
    return value;
  }
  return null;
};

/**
 * profile entry 1 つを SessionProfile に変換、不正なら null。
 * 不正条件: id 欠如 / kind 不正 / kind=agent で agent field 欠如。
 */
const toSessionProfile = (value: unknown): SessionProfile | null => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;

  const id = typeof obj.id === "string" && obj.id !== "" ? obj.id : null;
  if (id === null) return null;

  const kindRaw = obj.kind;
  const kind: SessionProfile["kind"] | null =
    kindRaw === "shell" || kindRaw === "agent" ? kindRaw : null;
  if (kind === null) return null;

  const agent: SessionProfile["agent"] = toSessionAgent(obj.agent);
  if (kind === "agent" && agent === null) return null;

  return {
    id,
    kind,
    command: typeof obj.command === "string" && obj.command !== "" ? obj.command : null,
    args: toStringArray(obj.args),
    env: toStringRecord(obj.env),
    cwd: typeof obj.cwd === "string" && obj.cwd !== "" ? obj.cwd : null,
    agent: kind === "shell" ? null : agent,
    integration: typeof obj.integration === "boolean" ? obj.integration : true,
  };
};

const toSessionProfiles = (value: unknown): ReadonlyArray<SessionProfile> => {
  if (!Array.isArray(value)) return [];
  return value.map(toSessionProfile).filter((p): p is SessionProfile => p !== null);
};

/**
 * SessionProfile を JSON object に。default 値の field は omit して config が
 * 必要以上に肥らないようにする。
 */
const serializeProfile = (p: SessionProfile): Record<string, unknown> => {
  const out: Record<string, unknown> = { id: p.id, kind: p.kind };
  if (p.command !== null) out.command = p.command;
  if (p.args.length > 0) out.args = [...p.args];
  if (Object.keys(p.env).length > 0) out.env = { ...p.env };
  if (p.cwd !== null) out.cwd = p.cwd;
  if (p.agent !== null) out.agent = p.agent;
  if (!p.integration) out.integration = false;
  return out;
};

/**
 * text が空 / 不正 JSON / 未知 field を含む場合も EMPTY_CONFIG に近い形に
 * 吸収する（tolerant parsing）。Charminal 本体は config の破損で落ちない。
 *
 * 旧 `activePersonas` field は silently ignored（YAGNI migration）。
 */
export function parseConfig(text: string): CharminalConfig {
  if (text.trim() === "") return EMPTY_CONFIG;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return EMPTY_CONFIG;
  }
  if (raw === null || typeof raw !== "object") return EMPTY_CONFIG;
  const obj = raw as Record<string, unknown>;
  return {
    disabledPacks: toStringArray(obj.disabledPacks),
    primaryPersona: toNullableString(obj.primaryPersona),
    mcpPort: toPort(obj.mcpPort),
    activeScene: toNullableString(obj.activeScene),
    activeUi: toNullableString(obj.activeUi),
    activeAmbientUi:
      "activeAmbientUi" in obj ? toStringArray(obj.activeAmbientUi) : EMPTY_CONFIG.activeAmbientUi,
    language: toAppLanguage(obj.language),
    terminalAgent: toTerminalAgent(obj.terminalAgent),
    ambientAudioMuted: toBoolean(obj.ambientAudioMuted),
    ambientAudioVolume: toUnitFloat(obj.ambientAudioVolume),
    profiles: toSessionProfiles(obj.profiles),
    defaultProfile: toNullableString(obj.defaultProfile),
    voiceFrequency: toVoiceFrequency(obj.voiceFrequency),
  };
}

/**
 * Empty array / null field は JSON output から omit する。書き戻したときに
 * ファイルが必要以上に肥らない。
 */
export function serializeConfig(cfg: CharminalConfig): string {
  const out: Record<string, unknown> = {};
  if (cfg.disabledPacks.length > 0) out.disabledPacks = cfg.disabledPacks;
  if (cfg.primaryPersona !== null) out.primaryPersona = cfg.primaryPersona;
  if (cfg.mcpPort !== null) out.mcpPort = cfg.mcpPort;
  if (cfg.activeScene !== null) out.activeScene = cfg.activeScene;
  if (cfg.activeUi !== null) out.activeUi = cfg.activeUi;
  if (!stringArraysEqual(cfg.activeAmbientUi, EMPTY_CONFIG.activeAmbientUi)) {
    out.activeAmbientUi = [...cfg.activeAmbientUi];
  }
  if (cfg.language !== DEFAULT_LANGUAGE) out.language = cfg.language;
  if (cfg.terminalAgent !== "claude") out.terminalAgent = cfg.terminalAgent;
  if (cfg.ambientAudioMuted) out.ambientAudioMuted = true;
  if (cfg.ambientAudioVolume !== 1.0) out.ambientAudioVolume = cfg.ambientAudioVolume;
  if (cfg.profiles.length > 0) out.profiles = cfg.profiles.map(serializeProfile);
  if (cfg.defaultProfile !== null) out.defaultProfile = cfg.defaultProfile;
  if (cfg.voiceFrequency !== "on") out.voiceFrequency = cfg.voiceFrequency;
  return `${JSON.stringify(out, null, 2)}\n`;
}

export function withDisabledPackAdded(cfg: CharminalConfig, id: string): CharminalConfig {
  if (cfg.disabledPacks.includes(id)) return cfg;
  return { ...cfg, disabledPacks: [...cfg.disabledPacks, id] };
}

export function withDisabledPackRemoved(cfg: CharminalConfig, id: string): CharminalConfig {
  if (!cfg.disabledPacks.includes(id)) return cfg;
  return {
    ...cfg,
    disabledPacks: cfg.disabledPacks.filter((p) => p !== id),
  };
}

/**
 * activeScene を id にセットした新しい config を返す。id が null ならクリア。
 */
export function withActiveSceneSet(cfg: CharminalConfig, id: string | null): CharminalConfig {
  return { ...cfg, activeScene: id };
}

/**
 * activeUi を id にセットした新しい config を返す。id が null ならクリア。
 * withActiveSceneSet と対称。
 */
export function withActiveUiSet(cfg: CharminalConfig, id: string | null): CharminalConfig {
  return { ...cfg, activeUi: id };
}

/**
 * primaryPersona を id にセットした新しい config を返す。id が null ならクリア。
 * withActiveSceneSet と対称。
 */
export function withPrimaryPersonaSet(cfg: CharminalConfig, id: string | null): CharminalConfig {
  return { ...cfg, primaryPersona: id };
}

/**
 * activeAmbientUi の配列を置き換えた新しい config を返す。
 */
export function withActiveAmbientUiSet(
  cfg: CharminalConfig,
  ids: ReadonlyArray<string>,
): CharminalConfig {
  return { ...cfg, activeAmbientUi: [...ids] };
}

export function withLanguageSet(cfg: CharminalConfig, language: AppLanguage): CharminalConfig {
  return { ...cfg, language };
}

export function withVoiceFrequencySet(
  cfg: CharminalConfig,
  voiceFrequency: VoiceFrequency,
): CharminalConfig {
  return { ...cfg, voiceFrequency };
}
