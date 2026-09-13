#!/usr/bin/env node
// Optional local QA. Playwright, a browser, and (for --film) ffmpeg are external tools.
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const { chromium } = await import(process.env.YORISHIRO_PLAYWRIGHT_MODULE || "playwright");
const output = resolve(process.env.YORISHIRO_SOURCE_QA_DIR || ".motion-review/source-replay");
const labUrl = new URL(
  process.env.YORISHIRO_SOURCE_LAB_URL || "http://127.0.0.1:1437/source-motion-lab.html",
);
if (!["localhost", "127.0.0.1", "[::1]"].includes(labUrl.hostname)) {
  throw new Error("Source motion QA requires a localhost page");
}
await mkdir(output, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.YORISHIRO_CHROME_PATH
    ? { executablePath: process.env.YORISHIRO_CHROME_PATH }
    : {}),
});
try {
  const page = await browser.newPage({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
  });
  const errors = [];
  const warnings = [];
  const resourceErrors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("response", (response) => {
    if (response.status() >= 400) {
      resourceErrors.push({ url: response.url(), status: response.status() });
    }
  });
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().startsWith("Failed to load resource:")) {
      errors.push(message.text());
    }
    if (message.type() === "warning") warnings.push(message.text());
  });
  await page.goto(labUrl.href);
  await page.waitForFunction(() => window.sourceMotionLab?.ready === true, null, {
    timeout: 90_000,
  });
  await page.evaluate(() => window.sourceMotionLab.pause());
  const observe = async (requested) => {
    const observation = await page.evaluate(() => window.sourceMotionLab.observations());
    const expected = Math.min(requested, observation.durationSeconds);
    if (Math.abs(observation.elapsedSeconds - expected) > 1e-7) {
      throw new Error(`Clock mismatch at ${requested}: ${observation.elapsedSeconds}`);
    }
    for (const lane of observation.lanes) {
      for (const [bone, coordinates] of Object.entries(lane)) {
        if (
          !Array.isArray(coordinates) ||
          coordinates.length !== 3 ||
          !coordinates.every(Number.isFinite)
        ) {
          throw new Error(`Invalid ${bone} coordinates at ${requested}`);
        }
      }
    }
    return observation;
  };
  const samples = [];
  const record = async (method, requested) => {
    samples.push({ method, requestedSeconds: requested, ...(await observe(requested)) });
    await page.screenshot({
      path: resolve(output, `${method}-${String(requested).padStart(2, "0")}.png`),
      fullPage: true,
    });
  };
  for (const time of [0, 3, 8, 15, 25]) {
    await page.evaluate((value) => window.sourceMotionLab.seek(value), time);
    await record("seek", time);
  }
  await page.evaluate(() => window.sourceMotionLab.seek(0));
  let previous = 0;
  for (const time of [0, 3, 8, 15, 25]) {
    if (time > previous) {
      await page.evaluate((delta) => window.sourceMotionLab.step(delta), time - previous);
    }
    await record("replay", time);
    previous = time;
  }
  let film = null;
  if (process.argv.includes("--film")) {
    await page.evaluate(() => window.sourceMotionLab.seek(0));
    const frames = resolve(output, "frames");
    await mkdir(frames, { recursive: true });
    const fps = 24;
    const durationSeconds = 25;
    for (let frame = 0; frame < durationSeconds * fps; frame++) {
      await observe(frame / fps);
      await page.screenshot({
        path: resolve(frames, `${String(frame).padStart(4, "0")}.jpg`),
        type: "jpeg",
        quality: 90,
        fullPage: true,
      });
      await page.evaluate((delta) => window.sourceMotionLab.step(delta), 1 / fps);
      if (frame % (5 * fps) === 0) console.log(`Source replay: ${frame / fps}/25 s`);
    }
    await observe(durationSeconds);
    const file = resolve(output, "source-comparison.mp4");
    await promisify(execFile)("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(fps),
      "-i",
      resolve(frames, "%04d.jpg"),
      "-frames:v",
      String(durationSeconds * fps),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      file,
    ]);
    film = { file, fps, durationSeconds, frameCount: durationSeconds * fps };
  }
  const failures = [
    ...errors,
    ...resourceErrors
      .filter((failure) => new URL(failure.url).pathname !== "/favicon.ico")
      .map((failure) => JSON.stringify(failure)),
  ];
  await writeFile(
    resolve(output, "observations.json"),
    `${JSON.stringify(
      {
        kind: "source-ingestion-comparison-not-animates",
        pageUrl: page.url(),
        status: await page.locator("#status").textContent(),
        errors,
        resourceErrors,
        warnings,
        samples,
        film,
      },
      null,
      2,
    )}\n`,
  );
  if (failures.length) throw new Error(failures.join("\n"));
  console.log(JSON.stringify({ output, samples: samples.length, film, warnings: warnings.length }));
} finally {
  await browser.close();
}
