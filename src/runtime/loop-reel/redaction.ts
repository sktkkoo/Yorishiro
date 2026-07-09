import {
  type LoopReelRedactionSources,
  loopReelRedactionSources,
} from "../../bindings/tauri-commands";
import type { RecordedEntry, SessionRecording } from "./types";

export type { LoopReelRedactionSources } from "../../bindings/tauri-commands";

export interface LoopReelRedactionOptions {
  readonly replacementChar?: string;
}

const DEFAULT_REPLACEMENT_CHAR = "*";

/**
 * PTY text を一度連結してから秘匿対象を置換し、元の chunk 長に分割し直す。
 *
 * P0 の既知制限: ANSI escape sequence が秘匿対象文字列の途中に挟まる場合、その値は
 * 一致しない。raw recording は store / disk ともに変更せず、表示用 projection だけを作る。
 */
export function redactLoopReelEntries(
  entries: readonly RecordedEntry[],
  sources: LoopReelRedactionSources,
  options: LoopReelRedactionOptions = {},
): readonly RecordedEntry[] {
  const terms = redactionTerms(sources);
  if (terms.length === 0) return entries;

  const ptyText = entries
    .filter((entry): entry is Extract<RecordedEntry, { kind: "pty" }> => entry.kind === "pty")
    .map((entry) => entry.text)
    .join("");
  if (ptyText.length === 0) return entries;

  const replacementChar = normalizeReplacementChar(options.replacementChar);
  const maskedText = terms.reduce(
    (text, term) => text.split(term).join(replacementChar.repeat(term.length)),
    ptyText,
  );
  if (maskedText === ptyText) return entries;

  let offset = 0;
  return entries.map((entry) => {
    if (entry.kind !== "pty") return entry;
    const nextOffset = offset + entry.text.length;
    const text = maskedText.slice(offset, nextOffset);
    offset = nextOffset;
    return { ...entry, text };
  });
}

export function redactLoopReelRecording(
  recording: SessionRecording,
  sources: LoopReelRedactionSources,
  options?: LoopReelRedactionOptions,
): SessionRecording {
  const entries = redactLoopReelEntries(recording.entries, sources, options);
  return entries === recording.entries ? recording : { ...recording, entries };
}

export const loadLoopReelRedactionSources = (): Promise<LoopReelRedactionSources> =>
  loopReelRedactionSources();

export function redactionTerms(sources: LoopReelRedactionSources): readonly string[] {
  const seen = new Set<string>();
  const terms = Object.values(sources)
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0)
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  return terms.sort((a, b) => b.length - a.length || a.localeCompare(b));
}

const normalizeReplacementChar = (value: string | undefined): string => {
  if (!value) return DEFAULT_REPLACEMENT_CHAR;
  const [first] = Array.from(value);
  if (!first || first.length !== 1) return DEFAULT_REPLACEMENT_CHAR;
  return first;
};
