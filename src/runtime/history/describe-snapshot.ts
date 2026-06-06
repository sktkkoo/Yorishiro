import type { SnapshotEntry } from "../../sdk/history";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function intlLocale(locale: string): string | undefined {
  return locale.trim() || undefined;
}

function isJapaneseLocale(locale: string): boolean {
  return locale.toLowerCase().startsWith("ja");
}

function compactJapaneseRelativeTime(text: string, locale: string): string {
  if (!isJapaneseLocale(locale)) return text;
  return text.replace(/\s+(?=[分時日])/g, "");
}

function relativeTime(locale: string, value: number, unit: "minute" | "hour"): string {
  const formatter = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "always" });
  return compactJapaneseRelativeTime(formatter.format(-value, unit), locale);
}

function dateTimeParts(tsMs: number, locale: string): Record<string, string> {
  const formatter = new Intl.DateTimeFormat(intlLocale(locale), {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(
    formatter
      .formatToParts(new Date(tsMs))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
}

function formatClockTime(tsMs: number, locale: string): string {
  const parts = dateTimeParts(tsMs, locale);
  return `${parts.hour}:${parts.minute}`;
}

function formatMonthDayTime(tsMs: number, locale: string): string {
  const parts = dateTimeParts(tsMs, locale);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function isYesterday(tsMs: number, nowMs: number): boolean {
  const now = new Date(nowMs);
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  const ts = new Date(tsMs);
  return (
    ts.getFullYear() === yesterday.getFullYear() &&
    ts.getMonth() === yesterday.getMonth() &&
    ts.getDate() === yesterday.getDate()
  );
}

/**
 * snapshot の時刻を UI 行用に整形する純関数。
 * 24 時間未満は相対、24 時間以上は絶対日付に倒す。
 */
export function formatSnapshotTime(tsMs: number, nowMs: number, locale: string): string {
  const ageMs = Math.max(0, nowMs - tsMs);
  if (ageMs < MINUTE_MS) return isJapaneseLocale(locale) ? "たった今" : "just now";
  if (ageMs < HOUR_MS) return relativeTime(locale, Math.floor(ageMs / MINUTE_MS), "minute");
  if (ageMs < DAY_MS) return relativeTime(locale, Math.floor(ageMs / HOUR_MS), "hour");
  if (isYesterday(tsMs, nowMs)) {
    const day = new Intl.RelativeTimeFormat(intlLocale(locale), { numeric: "auto" }).format(
      -1,
      "day",
    );
    return `${day} ${formatClockTime(tsMs, locale)}`;
  }
  return formatMonthDayTime(tsMs, locale);
}

/**
 * recovery 時の既定 restore 候補 seq を返す。snapshots は新しい順。最新（[0]）は
 * 「変更後＝現在の状態」なので戻し先にしない（restore しても no-op）。よって既定は
 * 1 つ前（[1]）＝「最新変更前」。以前の状態が無い（length <= 1）なら null（戻し先なし）。
 */
export function recommendedRestoreSeq(snapshots: ReadonlyArray<SnapshotEntry>): number | null {
  return snapshots[1]?.seq ?? null;
}

export interface ChangeStrings {
  readonly changedOnePack: (id: string) => string;
  readonly changedManyPacks: (n: number) => string;
  readonly changedManyPacksNamed: (names: readonly string[]) => string;
  readonly changedConfig: string;
  readonly changedInit: string;
  readonly changedMixed: (n: number) => string;
  readonly changeStartup: string;
  readonly changeStartupError: string;
  readonly changeManual: string;
  readonly changePreRestore: (time: string) => string;
  readonly changeSdkSnapshot: string;
  readonly changeUnknown: string;
}

/** pre-restore label から復元先の ts_ms を取り出す。形式: "restore-to:<seq>:<ts_ms>" */
export function parseRestoreLabel(label: string | undefined): number | null {
  if (!label) return null;
  const m = label.match(/^restore-to:\d+:(\d+)$/);
  return m ? Number(m[1]) : null;
}

function isUserVisibleChangedToken(value: string): boolean {
  return !value.startsWith(".") && !value.endsWith(".resttmp");
}

/**
 * snapshot の「何が起きたか」を user 語で返す純関数。
 * trigger / changed / label から適切なサマリーを生成する。
 */
export function describeChange(
  entry: SnapshotEntry,
  s: ChangeStrings,
  locale: string,
  nowMs: number,
): string {
  const label = entry.label?.trim();
  const changed = (entry.changed ?? []).filter(isUserVisibleChangedToken);
  if (changed.length === 0) {
    if (entry.trigger === "startup-baseline") {
      return entry.startup_clean === false ? s.changeStartupError : s.changeStartup;
    }
    if (entry.trigger === "pre-restore") {
      const targetTs = parseRestoreLabel(entry.label);
      if (targetTs !== null) {
        return s.changePreRestore(formatSnapshotTime(targetTs, nowMs, locale));
      }
      return label ?? s.changeUnknown;
    }
    if (entry.trigger === "mcp:snapshot") return label ?? s.changeManual;
    if (entry.trigger === "sdk:snapshot") return label ?? s.changeSdkSnapshot;
    return label ?? s.changeUnknown;
  }
  if (changed.length === 1) {
    const only = changed[0];
    if (only === "config.json") return s.changedConfig;
    if (only === "init.js") return s.changedInit;
    if (only !== undefined) return s.changedOnePack(only);
  }
  const hasSpecial = changed.some((c) => c === "config.json" || c === "init.js");
  if (!hasSpecial) return s.changedManyPacksNamed(changed);
  return s.changedMixed(changed.length);
}

export type StartupStatus = "error";

export interface RestoreRow {
  readonly seq: number;
  readonly changeText: string;
  readonly timeText: string;
  readonly changedItems: ReadonlyArray<string>;
  readonly startupStatus: StartupStatus | null;
  readonly isLatest: boolean;
  readonly isRecommended: boolean;
}

function startupStatus(entry: SnapshotEntry): StartupStatus | null {
  if (entry.startup_clean === false) return "error";
  return null;
}

export function buildRestoreRows(
  snapshots: ReadonlyArray<SnapshotEntry>,
  nowMs: number,
  s: ChangeStrings,
  locale: string,
  limit = 5,
): RestoreRow[] {
  const recommended = recommendedRestoreSeq(snapshots);
  return snapshots.slice(0, limit).map((entry, index) => ({
    seq: entry.seq,
    changeText: describeChange(entry, s, locale, nowMs),
    timeText: formatSnapshotTime(entry.ts_ms, nowMs, locale),
    changedItems: entry.changed ?? [],
    startupStatus: startupStatus(entry),
    isLatest: index === 0,
    isRecommended: entry.seq === recommended,
  }));
}
