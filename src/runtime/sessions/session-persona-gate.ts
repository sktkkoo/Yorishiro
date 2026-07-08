/**
 * Persona resume gate — resume していいのは、再開される会話がいまの persona の
 * ものであるときだけ。
 *
 * persona 切替時の fresh respawn（main-session-respawn-on-reload.ts）は「いま
 * 起動中の agent の次の 1 回の spawn」にしか効かず、他 agent・他 folder の
 * agent セッション（claude の `-c` / codex の `resume --last` が拾うスレッド）
 * には旧 persona との会話が残る。agent 切替や folder 復帰の resume がそれを
 * 蘇らせると、表示中の住人と会話ログの主が食い違う。
 *
 * そこで per (agent, place) で「最後に spawn した時点の persona」を
 * `~/.yorishiro/session-personas.json` に記録し、boot 時に現 persona と比較
 * して、変わっていたら resume を止める（実際の抑止は既存の
 * `withAgentResumePolicy` → `SpawnSpec.resume=false` 経路に乗る）。
 *
 * 安全側の原則：記録なし・読み込み失敗は resume 許可（従来挙動）に倒し、
 * gate の失敗で boot を止めない。セッションファイル自体には触れない
 * （Yorishiro が resume を仕掛けなくなるだけで、CLI からの手動 resume は
 * 妨げない）。
 */

import { isBundledClaiPersonaId } from "../user-pack-loader/config";

export interface SessionPersonaRecord {
  /** normalizePersonaForGate 済みの persona 識別子。 */
  readonly persona: string;
  /** この記録時点で gate が resume を許可したか（診断用）。 */
  readonly resumeAllowed: boolean;
  /** 記録時刻（ISO 8601、診断用）。 */
  readonly at: string;
}

/** agent id → place key（projectRoot / cwd）→ 記録。 */
export type SessionPersonaRecords = Readonly<
  Record<string, Readonly<Record<string, SessionPersonaRecord>>>
>;

/**
 * gate 比較用の persona 識別子。bundled CLAI（config 上は null / clai-*）は
 * 言語非依存の 1 つの persona として扱う。生の resolved id（clai-en / clai-ja）
 * で比較すると UI 言語の切替が persona 切替に誤爆する。
 */
export function normalizePersonaForGate(primaryPersona: string | null): string {
  if (primaryPersona === null || isBundledClaiPersonaId(primaryPersona)) return "clai";
  return primaryPersona;
}

function isRecord(value: unknown): value is SessionPersonaRecord {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { persona?: unknown; resumeAllowed?: unknown; at?: unknown };
  return (
    typeof candidate.persona === "string" &&
    typeof candidate.resumeAllowed === "boolean" &&
    typeof candidate.at === "string"
  );
}

/** 不在・破損はすべて空記録に吸収する tolerant parse。 */
export function parseSessionPersonaRecords(text: string): SessionPersonaRecords {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {};
  }
  if (typeof raw !== "object" || raw === null) return {};
  const records = (raw as { records?: unknown }).records;
  if (typeof records !== "object" || records === null) return {};
  const result: Record<string, Record<string, SessionPersonaRecord>> = {};
  for (const [agent, places] of Object.entries(records)) {
    if (typeof places !== "object" || places === null) continue;
    for (const [place, record] of Object.entries(places)) {
      if (!isRecord(record)) continue;
      result[agent] ??= {};
      result[agent][place] = record;
    }
  }
  return result;
}

export function serializeSessionPersonaRecords(records: SessionPersonaRecords): string {
  return `${JSON.stringify({ version: 1, records }, null, 2)}\n`;
}

/**
 * resume 可否。記録がない (agent, place) は許可（gate 導入前からのセッションや
 * 初回起動で会話を落とさない）。記録があれば persona 一致のときだけ許可。
 */
export function shouldAllowPersonaResume(
  records: SessionPersonaRecords,
  args: { readonly agent: string; readonly place: string; readonly persona: string },
): boolean {
  const record = records[args.agent]?.[args.place];
  return record === undefined || record.persona === args.persona;
}

/** (agent, place) の記録を immutable に更新する。他の agent / place は保持。 */
export function withSessionPersonaRecord(
  records: SessionPersonaRecords,
  args: {
    readonly agent: string;
    readonly place: string;
    readonly persona: string;
    readonly resumeAllowed: boolean;
    readonly at: string;
  },
): SessionPersonaRecords {
  return {
    ...records,
    [args.agent]: {
      ...records[args.agent],
      [args.place]: { persona: args.persona, resumeAllowed: args.resumeAllowed, at: args.at },
    },
  };
}
