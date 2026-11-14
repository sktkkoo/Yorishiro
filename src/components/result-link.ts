/** 明示操作で開く結果の URL。曖昧な表記や資格情報を含む宛先は採用しない。 */
export function resultLink(value: string | null | undefined): string | null {
  if (!value || !/^https?:\/\//i.test(value) || /[\s\\\p{Cc}]/u.test(value)) return null;
  try {
    const url = new URL(value);
    const authority = value.slice(value.indexOf("://") + 3).split(/[/?#]/, 1)[0];
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      Boolean(authority) &&
      !authority?.includes("@")
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export interface ResultTextPart {
  readonly text: string;
  readonly url: string | null;
}
const OPENING_BRACKETS: Readonly<Record<string, string>> = { ")": "(", "]": "[", "}": "{" };

/** 原文を変更せず、句読点と対応しない閉じ括弧をリンクの外に残す。 */
export function resultTextParts(text: string): ResultTextPart[] {
  const parts: ResultTextPart[] = [];
  const candidates = /https?:\/\/[^\s<>"'`。、！？；：「」『』【】〈〉《》（）]+/giu;
  let cursor = 0;
  for (const match of text.matchAll(candidates)) {
    const start = match.index;
    if (start > 0 && /[\w:/\\@.%+-]/.test(text[start - 1])) continue;
    const candidate = match[0];
    const counts: Record<string, number> = {};
    for (const character of candidate) {
      if ("()[]{}".includes(character)) counts[character] = (counts[character] ?? 0) + 1;
    }
    let end = candidate.length;
    while (end > 0) {
      const last = candidate[end - 1];
      const opening = OPENING_BRACKETS[last];
      if (/[.,!?;:]/.test(last) || (opening && (counts[last] ?? 0) > (counts[opening] ?? 0))) {
        if (opening) counts[last] -= 1;
        end -= 1;
      } else break;
    }
    const linkText = candidate.slice(0, end);
    const url = resultLink(linkText);
    if (!url) continue;
    if (cursor < start) parts.push({ text: text.slice(cursor, start), url: null });
    parts.push({ text: linkText, url });
    cursor = start + linkText.length;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), url: null });
  return parts;
}
