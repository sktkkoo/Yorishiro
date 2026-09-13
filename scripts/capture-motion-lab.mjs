#!/usr/bin/env node
// Optional visual QA driver. Uses a locally installed Playwright and browser.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const { chromium } = await import(process.env.YORISHIRO_PLAYWRIGHT_MODULE || "playwright");
const output = resolve(process.env.YORISHIRO_MOTION_QA_DIR || "/private/tmp/yorishiro-motion-qa");
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
} finally {
  await browser.close();
}
