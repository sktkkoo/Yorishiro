import type { SnapshotEntry } from "../../sdk/history";

/**
 * snapshot 1 件を recovery UI 用の 1 行に整形する純関数。
 * 例: `#5 watcher-settled · 2分前 · ✓起動clean`
 */
export function describeSnapshot(entry: SnapshotEntry, nowMs: number): string {
  const ageMin = Math.max(0, Math.round((nowMs - entry.ts_ms) / 60_000));
  const age = ageMin === 0 ? "たった今" : `${ageMin}分前`;
  const label = entry.label ? ` "${entry.label}"` : "";
  // nested ternary を避けて if/else（biome noNestedTernary 対策）。
  let clean = "";
  if (entry.startup_clean === true) clean = " · ✓起動clean";
  else if (entry.startup_clean === false) clean = " · ⚠起動エラーあり";
  return `#${entry.seq} ${entry.trigger}${label} · ${age}${clean}`;
}

/**
 * recovery 時の既定 restore 候補 seq を返す。snapshots は新しい順。最新（[0]）は
 * 「変更後＝現在の状態」なので戻し先にしない（restore しても no-op）。よって既定は
 * 1 つ前（[1]）＝「最新変更前」。以前の状態が無い（length <= 1）なら null（戻し先なし）。
 */
export function recommendedRestoreSeq(snapshots: ReadonlyArray<SnapshotEntry>): number | null {
  return snapshots[1]?.seq ?? null;
}

/**
 * `describeChange` が必要とする i18n 文言（focused interface）。
 * P2 で UiStrings から組み立てる。P1 では型と pure helper だけ用意する。
 */
export interface ChangeStrings {
  readonly changedOnePack: (id: string) => string;
  readonly changedManyPacks: (n: number) => string;
  readonly changedConfig: string;
  readonly changedInit: string;
  readonly changedMixed: (n: number) => string;
  readonly changeStartup: string;
  readonly changeManual: string;
  readonly changeUnknown: string;
}

/**
 * snapshot の「何が起きたか」を user 語で返す純関数（Scope C）。
 * `changed` があればそれを優先し、無ければ trigger / label に fallback する。
 * seq / trigger 名のような実装語彙は表に出さない。
 */
export function describeChange(entry: SnapshotEntry, s: ChangeStrings): string {
  const changed = entry.changed ?? [];
  if (changed.length === 0) {
    if (entry.trigger === "startup-baseline") return s.changeStartup;
    if (entry.trigger === "mcp:snapshot") return entry.label ?? s.changeManual;
    return entry.label ?? s.changeUnknown;
  }
  if (changed.length === 1) {
    const only = changed[0];
    if (only === "config.json") return s.changedConfig;
    if (only === "init.js") return s.changedInit;
    if (only !== undefined) return s.changedOnePack(only);
  }
  const hasSpecial = changed.some((c) => c === "config.json" || c === "init.js");
  if (!hasSpecial) return s.changedManyPacks(changed.length);
  return s.changedMixed(changed.length);
}

/** restore 一覧の 1 行。表示用の整形 text と、最新／推奨フラグを持つ。 */
export interface RestoreRow {
  readonly seq: number;
  readonly text: string;
  /** snapshots[0]（変更後＝現在に近い状態）か。 */
  readonly isLatest: boolean;
  /** 既定の戻し先（recommendedRestoreSeq）か。 */
  readonly isRecommended: boolean;
}

/**
 * snapshot 一覧を recovery / 設定 UI 用の表示行に変換する pure helper。
 * 直近 `limit` 件に絞り、最新（[0]）と推奨（recommendedRestoreSeq）を flag する。
 * 行 text は describeSnapshot。tag 文言は呼び出し側が isLatest / isRecommended から付ける。
 */
export function buildRestoreRows(
  snapshots: ReadonlyArray<SnapshotEntry>,
  nowMs: number,
  limit = 5,
): RestoreRow[] {
  const recommended = recommendedRestoreSeq(snapshots);
  return snapshots.slice(0, limit).map((entry, index) => ({
    seq: entry.seq,
    text: describeSnapshot(entry, nowMs),
    isLatest: index === 0,
    isRecommended: entry.seq === recommended,
  }));
}
