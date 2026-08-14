const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'`]+/giu;
const TRAILING_SENTENCE_PUNCTUATION = /[.,;!]+$/u;

const CLOSING_DELIMITERS = [
  [")", "("],
  ["]", "["],
  ["}", "{"],
] as const;

/**
 * Return the visible HTTP(S) URL under a text offset.
 *
 * Terminal output often surrounds links with prose or Markdown punctuation. We
 * keep balanced delimiters that belong to the URL and remove only unmatched
 * closers and sentence punctuation before validating the protocol.
 */
export function findHttpUrlAtTextOffset(text: string, offset: number): string | null {
  if (!Number.isInteger(offset) || offset < 0 || offset >= text.length) return null;

  for (const match of text.matchAll(HTTP_URL_PATTERN)) {
    const matchStart = match.index;
    if (matchStart === undefined || hasIdentifierPrefix(text, matchStart)) continue;

    const candidate = trimTerminalUrlPunctuation(match[0]);
    const matchEnd = matchStart + candidate.length;
    if (offset < matchStart || offset >= matchEnd) continue;

    try {
      const parsed = new URL(candidate);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return candidate;
    } catch {
      return null;
    }
  }

  return null;
}

function hasIdentifierPrefix(text: string, start: number): boolean {
  if (start === 0) return false;
  return /[\p{L}\p{N}_]/u.test(text[start - 1] ?? "");
}

function trimTerminalUrlPunctuation(raw: string): string {
  let candidate = raw.replace(TRAILING_SENTENCE_PUNCTUATION, "");
  let changed = true;

  while (changed) {
    changed = false;
    for (const [closing, opening] of CLOSING_DELIMITERS) {
      if (!candidate.endsWith(closing)) continue;
      if (count(candidate, closing) <= count(candidate, opening)) continue;
      candidate = candidate.slice(0, -closing.length);
      changed = true;
    }
  }

  return candidate.replace(TRAILING_SENTENCE_PUNCTUATION, "");
}

function count(value: string, token: string): number {
  let total = 0;
  for (const char of value) {
    if (char === token) total++;
  }
  return total;
}
