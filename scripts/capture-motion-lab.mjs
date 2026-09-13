#!/usr/bin/env node
import { execFile } from "node:child_process";
// Optional visual QA driver. Uses a locally installed Playwright and browser.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const { chromium } = await import(process.env.YORISHIRO_PLAYWRIGHT_MODULE || "playwright");
const output = resolve(process.env.YORISHIRO_MOTION_QA_DIR || ".motion-review");
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
  page.on("pageerror", (error) => errors.push(String(error)));
  const labUrl = new URL(
    process.env.YORISHIRO_MOTION_LAB_URL || "http://127.0.0.1:1437/motion-lab.html",
  );
  labUrl.searchParams.set("manual", "1");
  await page.goto(labUrl.href);
  await page.waitForFunction(() => window.motionLab?.ready === true, null, { timeout: 90_000 });
  await page.evaluate(() => window.motionLab.pause());
  const capture = async (name) => page.screenshot({ path: resolve(output, `${name}.png`) });
  await page.evaluate(() => window.motionLab.step(8));
  await capture("01-idle");
  await page.evaluate(() => window.motionLab.step(25));
  await capture("02-idle-transition");
  for (const intent of ["agree", "consider", "reassure", "emphasize"]) {
    await page.evaluate((value) => window.motionLab.gesture(value), intent);
    await page.evaluate(() => window.motionLab.step(2));
    await capture(`gesture-${intent}`);
    await page.evaluate(() => window.motionLab.step(6));
  }
  await page.evaluate(() => window.motionLab.step(120));
  await capture("03-long-idle");
  const observations = await page.evaluate(() => window.motionLab.observations());
  await writeFile(
    resolve(output, "observations.json"),
    `${JSON.stringify({ errors, ...observations }, null, 2)}\n`,
  );
  if (errors.length) throw new Error(errors.join("\n"));
  console.log(
    `Motion QA captured to ${output} (${observations.elapsedSeconds.toFixed(1)} simulated seconds)`,
  );
  if (process.argv.includes("--film")) {
    await page.reload();
    await page.waitForFunction(() => window.motionLab?.ready === true, null, { timeout: 90_000 });
    const frames = resolve(output, "frames");
    await mkdir(frames, { recursive: true });
    const fps = 24;
    for (let frame = 0; frame < 30 * fps; frame++) {
      if (frame === 6 * fps) await page.evaluate(() => window.motionLab.gesture("consider"));
      if (frame === 14 * fps) await page.evaluate(() => window.motionLab.gesture("emphasize"));
      if (frame === 22 * fps) await page.evaluate(() => window.motionLab.gesture("reassure"));
      await page.evaluate((delta) => window.motionLab.step(delta), 1 / fps);
      await page.screenshot({
        path: resolve(frames, `${String(frame).padStart(4, "0")}.jpg`),
        type: "jpeg",
        quality: 88,
      });
      if (frame % (5 * fps) === 0) console.log(`Rendered comparison: ${frame / fps}/30 s`);
    }
    const simulatedSeconds = await page.evaluate(
      () => window.motionLab.observations().elapsedSeconds,
    );
    if (Math.abs(simulatedSeconds - 30) > 1 / 60) {
      throw new Error(
        `Comparison timing drift: ${simulatedSeconds} simulated seconds for 30-second video`,
      );
    }
    await promisify(execFile)("ffmpeg", [
      "-y",
      "-loglevel",
      "error",
      "-framerate",
      String(fps),
      "-i",
      resolve(frames, "%04d.jpg"),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      resolve(output, "motion-comparison.mp4"),
    ]);
    console.log(`Comparison film: ${resolve(output, "motion-comparison.mp4")}`);
  }
} finally {
  await browser.close();
}
