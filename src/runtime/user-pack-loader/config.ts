/**
 * `~/.charminal/config.json` の shape と pure 変換 helper。
 *
 * File I/O は runtime-wire.ts が Tauri command 経由で組む。この module は
 * parse / serialize / field mutation を pure fn として閉じ込め、test 可能
 * な境界を作る。
 *
 * Schema:
 * - `disabledPacks: string[]`（optional）: rescue 用の flag 群
 * - `activePersonas: string[]`（optional）: 将来 persona activation 用
 * - `mcpPort: number`（optional）: MCP server の port override
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「触れるものと、触れないもの」
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.3
 */

export interface CharminalConfig {
  readonly disabledPacks: ReadonlyArray<string>;
  readonly activePersonas: ReadonlyArray<string>;
  readonly mcpPort: number | null;
}

export const EMPTY_CONFIG: CharminalConfig = {
  disabledPacks: [],
  activePersonas: [],
  mcpPort: null,
};

const toStringArray = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
};

const toPort = (value: unknown): number | null => {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
};

/**
 * text が空 / 不正 JSON / 未知 field を含む場合も EMPTY_CONFIG に近い形に
 * 吸収する（tolerant parsing）。Charminal 本体は config の破損で落ちない。
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
    activePersonas: toStringArray(obj.activePersonas),
    mcpPort: toPort(obj.mcpPort),
  };
}

/**
 * Empty array / null field は JSON output から omit する。書き戻したときに
 * ファイルが必要以上に肥らない。
 */
export function serializeConfig(cfg: CharminalConfig): string {
  const out: Record<string, unknown> = {};
  if (cfg.disabledPacks.length > 0) out.disabledPacks = cfg.disabledPacks;
  if (cfg.activePersonas.length > 0) out.activePersonas = cfg.activePersonas;
  if (cfg.mcpPort !== null) out.mcpPort = cfg.mcpPort;
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
