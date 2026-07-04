const SAFE_ASCII = /^[A-Za-z0-9_/:.,@%+=-]$/;

/**
 * OSC 633 の param 値を VSCode 互換寄せの `\xHH` 表現に escape する。
 * shell 側 init script も同じ wire format を emit する。
 */
export function encodeOsc633Value(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = "";
  for (const byte of bytes) {
    const char = String.fromCharCode(byte);
    if (SAFE_ASCII.test(char)) {
      out += char;
    } else {
      out += `\\x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
  }
  return out;
}

/**
 * OSC 633 の `\xHH` escape を UTF-8 文字列に戻す。malformed escape は
 * 端末内プログラム由来の best-effort 入力として、そのまま byte 列化する。
 */
export function decodeOsc633Value(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (char === "\\" && value[i + 1] === "x" && isHex(value[i + 2]) && isHex(value[i + 3])) {
      bytes.push(Number.parseInt(value.slice(i + 2, i + 4), 16));
      i += 3;
      continue;
    }
    const encoded = new TextEncoder().encode(char);
    for (const byte of encoded) {
      bytes.push(byte);
    }
  }
  return new TextDecoder("utf-8", { fatal: false }).decode(new Uint8Array(bytes));
}

function isHex(char: string | undefined): boolean {
  return char !== undefined && /^[0-9a-fA-F]$/.test(char);
}
