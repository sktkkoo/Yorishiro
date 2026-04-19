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
}

export const EMPTY_CONFIG: CharminalConfig = {
  disabledPacks: [],
  primaryPersona: null,
  mcpPort: null,
  activeScene: null,
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
 * primaryPersona を id にセットした新しい config を返す。id が null ならクリア。
 * withActiveSceneSet と対称。
 */
export function withPrimaryPersonaSet(cfg: CharminalConfig, id: string | null): CharminalConfig {
  return { ...cfg, primaryPersona: id };
}
