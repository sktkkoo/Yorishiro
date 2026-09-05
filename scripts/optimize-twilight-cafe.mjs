#!/usr/bin/env node
// 形状・UV・内包画像・BIN内の位置を保ち、喫茶室の屈折材質2個だけを置き換える。
// 屈折を残すと、Threeは画面全体のマルチサンプル対象へ不透明シーンを再描画する。
// 実行例: node scripts/optimize-twilight-cafe.mjs INPUT.glb OUTPUT.glb

import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const TRANSMISSION = "KHR_materials_transmission";
const GLASS_ALPHA = new Map([
  ["Glass | weathered translucent window", 0.14],
  ["Glass | amber bottle", 0.55],
]);

/** GLBの構造と、このアセットが使う単一の内包バッファを検証する。 */
export function parseGlb(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 28 || bytes.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error("Expected a GLB file");
  }
  if (bytes.readUInt32LE(4) !== 2) throw new Error("Expected GLB version 2");
  if (bytes.readUInt32LE(8) !== bytes.length) throw new Error("Invalid GLB declared length");

  const chunks = [];
  let offset = 12;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8) throw new Error("Truncated GLB chunk header");
    const length = bytes.readUInt32LE(offset);
    const type = bytes.readUInt32LE(offset + 4);
    const end = offset + 8 + length;
    if (length % 4 !== 0) throw new Error("Unaligned GLB chunk length");
    if (end > bytes.length) throw new Error("Truncated GLB chunk payload");
    chunks.push({ type, data: bytes.subarray(offset + 8, end) });
    offset = end;
  }
  if (
    chunks[0]?.type !== JSON_CHUNK ||
    chunks[1]?.type !== BIN_CHUNK ||
    chunks.filter((chunk) => chunk.type === JSON_CHUNK).length !== 1 ||
    chunks.filter((chunk) => chunk.type === BIN_CHUNK).length !== 1
  ) {
    throw new Error("Expected one JSON chunk followed by one BIN chunk");
  }

  const json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(chunks[0].data));
  if (json?.asset?.version !== "2.0") throw new Error("Expected glTF asset version 2.0");
  const bin = chunks[1].data;
  const buffer = json.buffers?.[0];
  if (
    json.buffers?.length !== 1 ||
    buffer.uri !== undefined ||
    !Number.isInteger(buffer.byteLength) ||
    buffer.byteLength < 0 ||
    buffer.byteLength > bin.length ||
    bin.length - buffer.byteLength > 3
  ) {
    throw new Error("Invalid embedded GLB buffer length or external buffer URI");
  }
  for (const view of json.bufferViews ?? []) {
    const start = view.byteOffset ?? 0;
    if (
      view.buffer !== 0 ||
      !Number.isInteger(start) ||
      start < 0 ||
      !Number.isInteger(view.byteLength) ||
      view.byteLength < 0 ||
      start + view.byteLength > buffer.byteLength
    ) {
      throw new Error("GLB bufferView lies outside its embedded buffer");
    }
  }
  return { json, bin, chunks };
}

/** 新しいGLBを返す。JSON以外のチャンクはバイト列をそのまま複製する。 */
export function optimizeTwilightCafe(bytes) {
  const { json, chunks } = parseGlb(bytes);
  if (!Array.isArray(json.materials)) throw new Error("The café has no materials");

  for (const [name, alpha] of GLASS_ALPHA) {
    const matches = json.materials.filter((material) => material.name === name);
    if (matches.length !== 1) throw new Error(`Expected exactly one material named ${name}`);
    const material = matches[0];
    if (material.extensions) {
      delete material.extensions[TRANSMISSION];
      if (Object.keys(material.extensions).length === 0) delete material.extensions;
    }
    material.alphaMode = "BLEND";
    // 片面の透明材質にして、裏面用の追加描画を避ける。
    material.doubleSided = false;
    material.pbrMetallicRoughness ??= {};
    material.pbrMetallicRoughness.baseColorFactor ??= [1, 1, 1, 1];
    material.pbrMetallicRoughness.baseColorFactor[3] = alpha;
  }
  if (json.materials.some((material) => material.extensions?.[TRANSMISSION] !== undefined)) {
    throw new Error("Unexpected additional transmission material; review it before optimizing");
  }
  for (const key of ["extensionsUsed", "extensionsRequired"]) {
    if (json[key]) json[key] = json[key].filter((extension) => extension !== TRANSMISSION);
  }

  const encoded = Buffer.from(JSON.stringify(json), "utf8");
  const padded = Buffer.alloc(Math.ceil(encoded.length / 4) * 4, 0x20);
  encoded.copy(padded);
  const outputChunks = [{ type: JSON_CHUNK, data: padded }, ...chunks.slice(1)];
  const size = 12 + outputChunks.reduce((total, chunk) => total + 8 + chunk.data.length, 0);
  const output = Buffer.alloc(size);
  output.writeUInt32LE(GLB_MAGIC, 0);
  output.writeUInt32LE(2, 4);
  output.writeUInt32LE(size, 8);
  let offset = 12;
  for (const chunk of outputChunks) {
    output.writeUInt32LE(chunk.data.length, offset);
    output.writeUInt32LE(chunk.type, offset + 4);
    chunk.data.copy(output, offset + 8);
    offset += 8 + chunk.data.length;
  }
  parseGlb(output);
  return output;
}

export async function optimizeFile(inputPath, outputPath) {
  if (resolve(inputPath) === resolve(outputPath)) {
    throw new Error("Input and output must be different files");
  }
  const input = await readFile(inputPath);
  const output = optimizeTwilightCafe(input);
  // 排他的に作成し、既存ファイルや入力へのシンボリックリンクも上書きしない。
  await writeFile(outputPath, output, { flag: "wx" });
  return { inputBytes: input.length, outputBytes: output.length, changedMaterials: 2 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2) {
    console.error("Usage: node scripts/optimize-twilight-cafe.mjs INPUT.glb OUTPUT.glb");
    process.exitCode = 1;
  } else {
    optimizeFile(args[0], args[1]).then(
      (result) => console.log(JSON.stringify(result, null, 2)),
      (error) => {
        console.error(`Twilight Café optimization failed: ${error.message}`);
        process.exitCode = 1;
      },
    );
  }
}
