import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { optimizeFile, optimizeTwilightCafe, parseGlb } from "./optimize-twilight-cafe.mjs";

const TRANSMISSION = "KHR_materials_transmission";
const WINDOW = "Glass | weathered translucent window";
const BOTTLE = "Glass | amber bottle";

function fixture() {
  const bin = Buffer.from([1, 2, 3, 4, 250, 251, 252, 253]);
  const json = {
    asset: { version: "2.0" },
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: bin.length }],
    extensionsUsed: [TRANSMISSION, "KHR_materials_clearcoat"],
    extensionsRequired: [TRANSMISSION],
    materials: [
      {
        name: WINDOW,
        doubleSided: true,
        extensions: { [TRANSMISSION]: { transmissionFactor: 0.92 } },
        pbrMetallicRoughness: { baseColorFactor: [0.67, 0.61, 0.38, 1] },
      },
      {
        name: BOTTLE,
        doubleSided: true,
        extensions: {
          [TRANSMISSION]: { transmissionFactor: 0.65 },
          KHR_materials_clearcoat: { clearcoatFactor: 0.2 },
        },
        pbrMetallicRoughness: { baseColorFactor: [0.28, 0.095, 0.025, 1] },
      },
      { name: "Ceramic | celadon glaze", pbrMetallicRoughness: { roughnessFactor: 0.72 } },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(json));
  const jsonLength = Math.ceil(encoded.length / 4) * 4;
  const bytes = Buffer.alloc(28 + jsonLength + bin.length, 0x20);
  bytes.writeUInt32LE(0x46546c67, 0);
  bytes.writeUInt32LE(2, 4);
  bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(jsonLength, 12);
  bytes.writeUInt32LE(0x4e4f534a, 16);
  encoded.copy(bytes, 20);
  bytes.writeUInt32LE(bin.length, 20 + jsonLength);
  bytes.writeUInt32LE(0x004e4942, 24 + jsonLength);
  bin.copy(bytes, 28 + jsonLength);
  return bytes;
}

describe("Twilight Café GLB optimizer", () => {
  it("changes only glass transparency and preserves binary geometry/image bytes", () => {
    const input = fixture();
    const untouched = Buffer.from(input);
    const before = parseGlb(input);
    const optimized = optimizeTwilightCafe(input);
    const after = parseGlb(optimized);

    expect(input).toEqual(untouched);
    expect(after.bin).toEqual(before.bin);
    expect(after.json.buffers).toEqual(before.json.buffers);
    expect(after.json.bufferViews).toEqual(before.json.bufferViews);
    expect(after.json.materials[2]).toEqual(before.json.materials[2]);
    expect(after.json.materials[0].pbrMetallicRoughness.baseColorFactor).toEqual([
      0.67, 0.61, 0.38, 0.14,
    ]);
    expect(after.json.materials[1].pbrMetallicRoughness.baseColorFactor).toEqual([
      0.28, 0.095, 0.025, 0.55,
    ]);
    expect(after.json.materials[1].extensions).toEqual({
      KHR_materials_clearcoat: { clearcoatFactor: 0.2 },
    });
    expect(after.json.extensionsUsed).not.toContain(TRANSMISSION);
    expect(after.json.extensionsRequired).not.toContain(TRANSMISSION);
    expect(optimizeTwilightCafe(optimized)).toEqual(optimized);
  });

  it("rejects corrupt GLB headers and chunks instead of producing a damaged asset", () => {
    const badVersion = fixture();
    badVersion.writeUInt32LE(1, 4);
    expect(() => optimizeTwilightCafe(badVersion)).toThrow("version 2");

    const shortFile = fixture().subarray(0, -1);
    expect(() => optimizeTwilightCafe(shortFile)).toThrow("declared length");

    const unaligned = fixture();
    unaligned.writeUInt32LE(unaligned.readUInt32LE(12) - 1, 12);
    expect(() => optimizeTwilightCafe(unaligned)).toThrow("Unaligned");

    const oversizedChunk = fixture();
    oversizedChunk.writeUInt32LE(oversizedChunk.length, 12);
    expect(() => optimizeTwilightCafe(oversizedChunk)).toThrow("Truncated");

    const missingBin = fixture();
    missingBin.writeUInt32LE(0x4e4f534a, 24 + missingBin.readUInt32LE(12));
    expect(() => optimizeTwilightCafe(missingBin)).toThrow("one BIN chunk");
  });

  it("refuses to overwrite the source or an existing output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "twilight-cafe-optimizer-"));
    try {
      const inputPath = join(directory, "source.glb");
      const outputPath = join(directory, "output.glb");
      const source = fixture();
      await writeFile(inputPath, source);
      await expect(optimizeFile(inputPath, inputPath)).rejects.toThrow("different files");
      await optimizeFile(inputPath, outputPath);
      const output = await readFile(outputPath);
      await expect(optimizeFile(inputPath, outputPath)).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(inputPath)).toEqual(source);
      expect(await readFile(outputPath)).toEqual(output);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe("bundled Twilight Café rendering budget", () => {
  it("ships the detailed room without enabling Three's full-scene transmission pass", async () => {
    const packRoot = resolve(import.meta.dirname, "../bundled-packs/scenes/amber-window-room");
    const source = await readFile(join(packRoot, "scene.tsx"), "utf8");
    const match = source.match(/resolveAsset\(["'](\.\/assets\/[^"']+\.glb)["']\)/);
    expect(match, "The scene should load its bundled GLB").not.toBeNull();
    const { json } = parseGlb(await readFile(resolve(packRoot, match[1])));

    expect(json.meshes).toHaveLength(31);
    expect(json.materials).toHaveLength(31);
    expect(json.images).toHaveLength(23);
    expect(json.images.every((image) => Number.isInteger(image.bufferView) && !image.uri)).toBe(
      true,
    );
    const triangles = json.meshes
      .flatMap((mesh) => mesh.primitives)
      .reduce((total, primitive) => {
        expect(primitive.mode ?? 4).toBe(4);
        expect(primitive.attributes).toHaveProperty("TEXCOORD_0");
        expect(primitive.attributes).toHaveProperty("TEXCOORD_1");
        return total + json.accessors[primitive.indices].count / 3;
      }, 0);
    expect(triangles).toBe(73_864);
    expect(json.extensionsUsed ?? []).not.toContain(TRANSMISSION);
    expect(json.extensionsRequired ?? []).not.toContain(TRANSMISSION);
    expect(json.materials.every((material) => !material.extensions?.[TRANSMISSION])).toBe(true);

    for (const [name, alpha] of [
      [WINDOW, 0.14],
      [BOTTLE, 0.55],
    ]) {
      const material = json.materials.find((candidate) => candidate.name === name);
      expect(material).toMatchObject({
        alphaMode: "BLEND",
        doubleSided: false,
        pbrMetallicRoughness: { baseColorFactor: expect.arrayContaining([alpha]) },
      });
      expect(material.pbrMetallicRoughness.baseColorFactor[3]).toBe(alpha);
    }
  });
});
