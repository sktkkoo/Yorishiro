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
 * - `terminalAgent: "claude" | "codex"`（optional）: Terminal で自動起動する coding agent
 * - `ambientAudioMuted: boolean`（optional）: scene pack の環境音を mute する
 *
 * Migration note: 旧 `activePersonas` field は parseConfig で silently ignored
 * （YAGNI — user の既存 config は新規 field が無いだけで壊れない）。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-19-persona-single-active.md
 */

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
  /** Terminal で自動起動する coding agent。未指定なら Claude Code。 */
  readonly terminalAgent: TerminalAgent;
  /** Scene pack の `ambient` 宣言で再生される環境音を mute する。 */
  readonly ambientAudioMuted: boolean;
  /** 環境音のマスターボリューム（0.0-1.0）。全 Howl の volume にこの値を乗算する。 */
  readonly ambientAudioVolume: number;
}

export type TerminalAgent = "claude" | "codex";

export const EMPTY_CONFIG: CharminalConfig = {
  disabledPacks: [],
  primaryPersona: null,
  mcpPort: null,
  activeScene: null,
  activeUi: null,
  activeAmbientUi: ["attention-aura"],
  terminalAgent: "claude",
  ambientAudioMuted: false,
  ambientAudioVolume: 1.0,
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
};

const toPort = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

const toNullableString = (value: unknown): string | null => {
  return typeof value === "string" && value !== "" ? value : null;
};

const toTerminalAgent = (value: unknown): TerminalAgent => {
  return value === "codex" ? "codex" : "claude";
};

const toBoolean = (value: unknown): boolean => {
  return value === true;
};

/** 0.0-1.0 の float を返す。無効値は 1.0（default）に fallback。 */
const toUnitFloat = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1.0;
  return Math.max(0, Math.min(1, value));
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
    terminalAgent: toTerminalAgent(obj.terminalAgent),
    ambientAudioMuted: toBoolean(obj.ambientAudioMuted),
    ambientAudioVolume: toUnitFloat(obj.ambientAudioVolume),
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
  if (cfg.activeAmbientUi.length > 0) out.activeAmbientUi = [...cfg.activeAmbientUi];
  if (cfg.terminalAgent !== "claude") out.terminalAgent = cfg.terminalAgent;
  if (cfg.ambientAudioMuted) out.ambientAudioMuted = true;
  if (cfg.ambientAudioVolume !== 1.0) out.ambientAudioVolume = cfg.ambientAudioVolume;
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
