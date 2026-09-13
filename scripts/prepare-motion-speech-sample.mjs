#!/usr/bin/env node
// Generates a review fixture to a file; never plays sound or downloads a voice.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

if (process.platform !== "darwin") throw new Error("This fixture generator requires macOS say");
const run = promisify(execFile);
const voice = "Kyoko";
const { stdout: voices } = await run("/usr/bin/say", ["-v", "?"]);
if (!voices.split("\n").some((line) => /^Kyoko\s+ja_JP\s/.test(line))) {
  throw new Error("The local Japanese Kyoko voice is not installed; no voice will be downloaded");
}
const text =
  "今日は、作業を始める前に、進め方を一緒に整理しましょう。" +
  "まず、今わかっていることを確かめてから、小さな手順に分けて試します。" +
  "途中で気になるところがあれば、その場で立ち止まって見直せます。" +
  "そうですね。急いで全部を決める必要はありません。" +
  "大丈夫です。一つずつ確かめながら、納得できる形にしていきましょう。";
const directory = resolve(".motion-review/speech-sample");
await mkdir(directory, { recursive: true });
const temporary = resolve(directory, "sample.raw.wav");
await run("/usr/bin/say", [
  "-v",
  voice,
  "-r",
  "180",
  "-o",
  temporary,
  "--file-format=WAVE",
  "--data-format=LEI16@24000",
  "--",
  text,
]);
const raw = await readFile(temporary);
if (raw.toString("ascii", 0, 4) !== "RIFF" || raw.toString("ascii", 8, 12) !== "WAVE") {
  throw new Error("say did not create a RIFF WAV");
}
// Match the application's OS synthesis cleanup for WebKit-compatible PCM WAV.
const chunks = [];
let bytesPerSecond = 0;
let dataBytes = 0;
for (let offset = 12; offset + 8 <= raw.length; ) {
  const id = raw.toString("ascii", offset, offset + 4);
  const size = raw.readUInt32LE(offset + 4);
  const end = offset + 8 + size + (size % 2);
  if (end > raw.length) throw new Error("Truncated WAV chunk");
  if (id === "fmt ") bytesPerSecond = raw.readUInt32LE(offset + 16);
  if (id === "data") dataBytes += size;
  if (id !== "FLLR") chunks.push(raw.subarray(offset, end));
  offset = end;
}
if (bytesPerSecond <= 0 || dataBytes <= 0) throw new Error("The generated WAV has no PCM audio");
const wav = Buffer.concat([raw.subarray(0, 12), ...chunks]);
wav.writeUInt32LE(wav.length - 8, 4);
await writeFile(temporary, wav);
await rename(temporary, resolve(directory, "sample.wav"));
const manifest = {
  schemaVersion: 1,
  source: "Installed macOS say voice; generated locally without playback",
  voice,
  language: "ja-JP",
  text,
  durationSeconds: dataBytes / bytesPerSecond,
  sha256: createHash("sha256").update(wav).digest("hex"),
};
await writeFile(resolve(directory, "sample.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ directory, voice, durationSeconds: manifest.durationSeconds }));
