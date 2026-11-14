// The app-server rejects an initial item above 8192 estimated tokens. Bound
// serialized UTF-8 bytes conservatively instead of assuming characters/token
// (which varies substantially for Japanese, emoji and escaped JSON).
export const MAX_REALTIME_TEXT_JSON_BYTES = 6 * 1024;
const encoder = new TextEncoder();

export function realtimeTextBytes(text: string): number {
  return encoder.encode(JSON.stringify(text)).length;
}

function splitText(text: string, budget: number): string[] {
  const parts: string[] = [];
  let part = "";
  let bytes = 2; // JSON string quotes.
  for (const point of text) {
    const cost = realtimeTextBytes(point) - 2;
    if (bytes + cost > budget && part) {
      parts.push(part);
      part = "";
      bytes = 2;
    }
    part += point;
    bytes += cost;
  }
  if (part) parts.push(part);
  return parts;
}

/** Lossless ordered fragments; never trims persona instructions or splits a
 * Unicode code point. Repeat passive-refresh guidance on every refresh item. */
export function realtimeContextParts(text: string, prefix = ""): readonly string[] {
  if (realtimeTextBytes(prefix + text) <= MAX_REALTIME_TEXT_JSON_BYTES) return [prefix + text];
  const budget = MAX_REALTIME_TEXT_JSON_BYTES - realtimeTextBytes(prefix) - 256;
  if (budget < 8) throw new Error("Realtime context prefix exceeds its item budget");
  const parts = splitText(text, budget);
  return parts.map(
    (part, index) =>
      `${prefix}Host context fragment ${index + 1}/${parts.length}. Read these in order as one context, not new user requests. Do not rely on an incomplete group; wait for all parts.\n${part}`,
  );
}
