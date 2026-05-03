/**
 * 簡易 1D Perlin-like noise. flicker irregularity / camera drift で使う.
 * 厳密な Perlin ではなく cosine 補間 value noise. 十分滑らかで cheap.
 */

const HASH_SIZE = 256;
const hashTable: number[] = (() => {
  const seed = 0x5eedf007;
  const table: number[] = [];
  let state = seed;
  for (let i = 0; i < HASH_SIZE; i += 1) {
    state = (state * 1664525 + 1013904223) | 0;
    table.push(((state >>> 0) / 0xffffffff) * 2 - 1);
  }
  return table;
})();

const lookup = (i: number): number => {
  const idx = ((i % HASH_SIZE) + HASH_SIZE) % HASH_SIZE;
  return hashTable[idx] ?? 0;
};

const cosineLerp = (a: number, b: number, t: number): number => {
  const f = (1 - Math.cos(t * Math.PI)) * 0.5;
  return a * (1 - f) + b * f;
};

export function perlin1d(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  return cosineLerp(lookup(i), lookup(i + 1), f);
}
