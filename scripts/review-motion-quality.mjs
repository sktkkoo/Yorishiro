#!/usr/bin/env node
/**
 * Reproducible actual-avatar diagnostics, isolated from the running native app.
 * node scripts/review-motion-quality.mjs --root /path/to/checkout --label before
 * External tools: existing Playwright + Chrome; no downloads or asset writes.
 * Run fetch-assets in the target checkout first. A git-archive baseline may use
 * this same dev harness: only its new QA page/module are overlaid onto --root.
 */
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { copyFile, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { createGzip } from "node:zlib";
import * as THREE from "three";
import { createServer } from "vite";

const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index];
  const value = process.argv[index + 1];
  if (!key.startsWith("--") || value === undefined) throw new Error("Options require --name value");
  args.set(key.slice(2), value);
}
const root = resolve(args.get("root") ?? here);
const label = args.get("label") ?? "candidate";
const output = resolve(args.get("out") ?? resolve(here, ".motion-review/quality", label));
const port = Number(args.get("port") ?? 1443);
const seed = Number(args.get("seed") ?? 738);
const liveSeconds = Number(args.get("live-seconds") ?? 32);
const simulationSeconds = Number(args.get("seconds") ?? 500);
if (!Number.isInteger(port) || port < 1024 || port > 65535 || [1430, 1439].includes(port))
  throw new Error("Choose an isolated lab port, not the native app port");
if (
  !Number.isFinite(simulationSeconds) ||
  simulationSeconds < 0 ||
  simulationSeconds > 1200 ||
  !Number.isFinite(liveSeconds) ||
  liveSeconds < 0 ||
  liveSeconds > 120
)
  throw new Error("Invalid duration");
await mkdir(output, { recursive: true });
if (root !== here) {
  await mkdir(resolve(root, "src/dev"), { recursive: true });
  for (const file of ["motion-quality-lab.html", "src/dev/motion-quality-lab.ts"])
    await copyFile(resolve(here, file), resolve(root, file));
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const manifest = [];
async function fingerprint(directory, prefix = "") {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const name = `${prefix}${item.name}`;
    if (item.isDirectory()) await fingerprint(resolve(directory, item.name), `${name}/`);
    else if (/\.(vrma|vrm|json)$/.test(name))
      manifest.push({ file: name, sha256: hash(await readFile(resolve(directory, item.name))) });
  }
}
await fingerprint(resolve(root, "public/animations"), "animations/");
await fingerprint(resolve(root, "public/models"), "models/");
manifest.sort((a, b) => a.file.localeCompare(b.file));
async function fingerprintSources() {
  const files = ["src/dev/motion-quality-lab.ts", "src/runtime/view-mode-framing.ts"];
  async function visit(directory) {
    for (const entry of await readdir(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) await visit(path);
      else if (path.endsWith(".ts") && !path.endsWith(".test.ts")) files.push(path);
    }
  }
  await visit("src/core/body");
  files.sort();
  return Object.fromEntries(
    await Promise.all(files.map(async (file) => [file, hash(await readFile(resolve(root, file)))])),
  );
}
const sourceHashes = await fingerprintSources();
const server = await createServer({
  configFile: false,
  root,
  base: "/",
  cacheDir: resolve(output, "vite-cache"),
  server: {
    host: "127.0.0.1",
    port,
    strictPort: true,
    hmr: false,
    watch: { ignored: ["**/*"] },
    fs: { allow: [root, here, resolve(root, "node_modules")] },
  },
  optimizeDeps: {
    entries: ["motion-quality-lab.html"],
    include: ["three", "@pixiv/three-vrm", "@pixiv/three-vrm-animation"],
  },
  logLevel: "warn",
});
const playwrightModule = process.env.YORISHIRO_PLAYWRIGHT_MODULE || "playwright";
// Reuse an explicitly supplied local encoder in this run's private directory.
// This avoids a Playwright download without changing the user's global tools.
if (liveSeconds > 0 && process.env.YORISHIRO_FFMPEG_PATH) {
  const require = createRequire(import.meta.resolve(playwrightModule));
  const registryPath = resolve(
    dirname(require.resolve("playwright-core/package.json")),
    "browsers.json",
  );
  const registry = JSON.parse(await readFile(registryPath, "utf8"));
  const revision = registry.browsers.find((entry) => entry.name === "ffmpeg")?.revision;
  if (!revision) throw new Error("Playwright ffmpeg revision not found");
  const toolsRoot = resolve(output, "playwright-tools");
  const encoderDirectory = resolve(toolsRoot, `ffmpeg-${revision}`);
  await mkdir(encoderDirectory, { recursive: true });
  const executable =
    process.platform === "darwin"
      ? "ffmpeg-mac"
      : process.platform === "win32"
        ? "ffmpeg-win64.exe"
        : "ffmpeg-linux";
  try {
    await symlink(process.env.YORISHIRO_FFMPEG_PATH, resolve(encoderDirectory, executable));
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  process.env.PLAYWRIGHT_BROWSERS_PATH = toolsRoot;
}
const { chromium } = await import(playwrightModule);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.YORISHIRO_CHROME_PATH
    ? { executablePath: process.env.YORISHIRO_CHROME_PATH }
    : {}),
  args: [
    "--mute-audio",
    "--disable-background-timer-throttling",
    "--disable-renderer-backgrounding",
  ],
});
const url = `http://127.0.0.1:${port}/motion-quality-lab.html?label=${encodeURIComponent(label)}&seed=${seed}`;
const errors = [],
  warnings = [],
  resources = [];
function observe(page) {
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "warning") warnings.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !response.url().endsWith("favicon.ico"))
      resources.push({ url: response.url(), status: response.status() });
  });
}
async function open(context) {
  const page = await context.newPage();
  observe(page);
  await page.goto(url);
  await page.waitForFunction(() => window.motionQualityLab?.ready, null, { timeout: 90_000 });
  return page;
}
const schedule = [
  [0, { phase: "idle", intensity: 1, scenario: "idle-normal" }],
  [300, { phase: "user-speaking", scenario: "listening" }],
  [320, { phase: "assistant-responding", scenario: "thinking" }],
  [330, { phase: "assistant-speaking", scenario: "speech-normal" }],
  [346, { gesture: "emphasize" }],
  [375, { phase: "interrupted", scenario: "interruption" }],
  [378, { phase: "user-speaking", scenario: "listening-after-interruption" }],
  [395, { phase: "idle", scenario: "idle-return" }],
  [410, { intensity: 0.5, scenario: "idle-calm" }],
  [425, { intensity: 1, scenario: "idle-normal-return" }],
  [440, { intensity: 2, scenario: "idle-lively" }],
  [455, { intensity: 3, scenario: "idle-over" }],
  [470, { intensity: 0, scenario: "zero" }],
  [475, { intensity: 1, scenario: "resume" }],
  [485, { phase: "assistant-speaking", scenario: "speech-resume" }],
];

function statistics(bones) {
  const groups = {},
    allFrames = [],
    starts = [],
    suspects = [],
    wall = [],
    commands = [];
  let previous = null,
    velocity = null,
    seen = new Set(),
    count = 0;
  const indexOf = (bone) => bones.indexOf(bone) * 7;
  const positionAt = (frame, bone) => frame.pose.slice(indexOf(bone) + 4, indexOf(bone) + 7);
  const q = new THREE.Quaternion(),
    p = new THREE.Quaternion(),
    predicted = new THREE.Quaternion(),
    difference = new THREE.Quaternion(),
    axis = new THREE.Vector3();
  const range = (group, key, value) => {
    group.ranges[key] ??= { min: Infinity, max: -Infinity, sum: 0, count: 0 };
    const current = group.ranges[key];
    current.min = Math.min(current.min, value);
    current.max = Math.max(current.max, value);
    current.sum += value;
    current.count++;
  };
  return {
    add(chunk) {
      wall.push(...chunk.wallFrames);
      commands.push(...chunk.commands);
      for (const frame of chunk.frames) {
        count++;
        groups[frame.scenario] ??= {
          seconds: 0,
          frames: 0,
          ranges: {},
          occupancySeconds: {},
          footOrigin: {},
          maxFootDisplacementM: {},
          recordedHeldSeconds: 0,
          recordedPhaseStallFrames: 0,
        };
        const group = groups[frame.scenario];
        group.seconds += frame.delta;
        group.frames++;
        if (frame.intensity > 0 && frame.recorded.active?.held)
          group.recordedHeldSeconds += frame.delta;
        if (
          previous &&
          frame.intensity > 0 &&
          frame.recorded.active &&
          previous.recorded.active &&
          frame.recorded.active.id === previous.recorded.active.id &&
          Math.abs(frame.recorded.active.phaseSec - previous.recorded.active.phaseSec) < 1e-9
        )
          group.recordedPhaseStallFrames++;
        const active = frame.actions.filter(
          (action) => action.layer === "performance" && action.weight > 0.001,
        );
        const present = new Set(active.map((action) => action.id));
        for (const action of active) {
          group.occupancySeconds[action.animation] =
            (group.occupancySeconds[action.animation] ?? 0) + frame.delta;
          if (!seen.has(action.id))
            starts.push({ at: frame.at, scenario: frame.scenario, ...action });
        }
        seen = present;
        const chest = positionAt(frame, "upperChest");
        for (const bone of ["leftHand", "rightHand", "head", "leftUpperArm", "rightUpperArm"])
          range(group, `${bone}HeightRelativeChestM`, positionAt(frame, bone)[1] - chest[1]);
        range(
          group,
          "meanShoulderHeightRelativeChestM",
          (positionAt(frame, "leftUpperArm")[1] + positionAt(frame, "rightUpperArm")[1]) / 2 -
            chest[1],
        );
        for (const bone of ["leftFoot", "leftToes", "rightFoot", "rightToes"]) {
          const point = positionAt(frame, bone);
          group.footOrigin[bone] ??= point;
          const origin = group.footOrigin[bone];
          const displacement = Math.hypot(...point.map((value, i) => value - origin[i]));
          group.maxFootDisplacementM[bone] = Math.max(
            group.maxFootDisplacementM[bone] ?? 0,
            displacement,
          );
          range(group, `${bone}Y`, point[1]);
        }
        const nextVelocity = new Float64Array(bones.length * 6);
        if (
          previous &&
          frame.delta > 0 &&
          frame.delta < 0.1 &&
          previous.intensity > 0 &&
          frame.intensity > 0
        ) {
          for (let i = 0; i < bones.length; i++) {
            const offset = i * 7,
              v = i * 6,
              dt = frame.delta;
            p.fromArray(previous.pose, offset).normalize();
            q.fromArray(frame.pose, offset).normalize();
            difference.copy(p).invert().premultiply(q).normalize();
            if (difference.w < 0)
              difference.set(-difference.x, -difference.y, -difference.z, -difference.w);
            const sine = Math.hypot(difference.x, difference.y, difference.z);
            const factor = sine > 1e-10 ? (2 * Math.atan2(sine, difference.w)) / (sine * dt) : 0;
            nextVelocity.set(
              [difference.x * factor, difference.y * factor, difference.z * factor],
              v,
            );
            for (let j = 0; j < 3; j++)
              nextVelocity[v + 3 + j] =
                (frame.pose[offset + 4 + j] - previous.pose[offset + 4 + j]) / dt;
            if (!velocity) continue;
            axis.fromArray(velocity, v);
            const speed = axis.length();
            predicted.identity();
            if (speed > 1e-10)
              predicted.setFromAxisAngle(axis.multiplyScalar(1 / speed), speed * dt);
            predicted.multiply(p).normalize();
            const angularError = predicted.angleTo(q);
            const linearError = Math.hypot(
              ...[0, 1, 2].map(
                (j) =>
                  frame.pose[offset + 4 + j] -
                  previous.pose[offset + 4 + j] -
                  velocity[v + 3 + j] * dt,
              ),
            );
            const accelerationDt = (dt + previous.delta) / 2;
            const angularAcceleration =
              Math.hypot(...[0, 1, 2].map((j) => nextVelocity[v + j] - velocity[v + j])) /
              accelerationDt;
            const linearAcceleration =
              Math.hypot(...[0, 1, 2].map((j) => nextVelocity[v + 3 + j] - velocity[v + 3 + j])) /
              accelerationDt;
            if (
              (angularError > 0.05 && angularAcceleration > 120) ||
              (linearError > 0.015 && linearAcceleration > 25)
            )
              suspects.push({
                at: frame.at,
                scenario: frame.scenario,
                bone: bones[i],
                angularError,
                linearError,
                angularAcceleration,
                linearAcceleration,
                actions: active,
                recorded: frame.recorded.active,
                previousRecorded: previous.recorded.active,
              });
          }
          velocity = nextVelocity;
        } else velocity = null;
        if (count % 6 === 0) allFrames.push({ ...frame, pose: undefined });
        previous = frame;
      }
    },
    result() {
      for (const group of Object.values(groups))
        for (const entry of Object.values(group.ranges)) entry.mean = entry.sum / entry.count;
      const frameMs = wall.map((frame) => frame.deltaMs).sort((a, b) => a - b);
      const percentile = (p) => frameMs[Math.floor((frameMs.length - 1) * p)] ?? null;
      return {
        diagnosticFilter: {
          meaning: "Candidate discontinuities, not perceptual failures",
          rotation: "parent-space local quaternion prediction",
          position: "avatar-space joint-origin prediction; curved intentional motion may flag",
          distinctFromProductionMonitor: true,
          thresholds: {
            angularErrorRad: 0.05,
            angularAccelerationRadSec2: 120,
            positionErrorM: 0.015,
            linearAccelerationMSec2: 25,
            frameStallMs: 100,
          },
        },
        frameCount: count,
        groups,
        starts,
        suspectJointFrames: suspects.length,
        suspectMoments: new Set(suspects.map((entry) => entry.at)).size,
        largestSuspects: suspects
          .sort(
            (a, b) =>
              Math.max(b.angularError / 0.05, b.linearError / 0.015) -
              Math.max(a.angularError / 0.05, a.linearError / 0.015),
          )
          .slice(0, 60),
        selectionTrace10Hz: allFrames,
        commands,
        wallClock: {
          frames: wall.length,
          p50Ms: percentile(0.5),
          p95Ms: percentile(0.95),
          p99Ms: percentile(0.99),
          maxMs: frameMs.at(-1) ?? null,
          stalls100Ms: frameMs.filter((value) => value >= 100).length,
          trace: wall,
        },
      };
    },
  };
}

async function recorder(page, name) {
  const metadata = await page.evaluate(() => window.motionQualityLab.snapshot());
  const stats = statistics(metadata.bones);
  const gzip = createGzip();
  const destination = createWriteStream(resolve(output, `${name}-frames.jsonl.gz`));
  gzip.pipe(destination);
  return {
    async drain() {
      const chunk = await page.evaluate(() => window.motionQualityLab.drain());
      stats.add(chunk);
      for (const frame of chunk.frames) gzip.write(`${JSON.stringify(frame)}\n`);
    },
    async finish() {
      await this.drain();
      gzip.end();
      await finished(destination);
      const final = await page.evaluate(() => window.motionQualityLab.snapshot());
      const result = { metadata, final, ...stats.result() };
      await writeFile(resolve(output, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
      return result;
    },
  };
}

try {
  await server.listen();
  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
  });
  const page = await open(context);
  const capture = await recorder(page, "simulated");
  let at = 0,
    next = 0;
  while (at < simulationSeconds) {
    while (next < schedule.length && schedule[next][0] <= at)
      await page.evaluate((input) => window.motionQualityLab.command(input), schedule[next++][1]);
    const end = Math.min(at + 5, schedule[next]?.[0] ?? Infinity, simulationSeconds);
    await page.evaluate((seconds) => window.motionQualityLab.step(seconds), end - at);
    at = end;
    await capture.drain();
    if (
      [8, 30, 120, 300, 320, 330, 345, 375, 380, 410, 425, 440, 455, 470, 475, 485, 500].includes(
        at,
      )
    )
      await page.screenshot({ path: resolve(output, `sim-${String(at).padStart(3, "0")}.png`) });
    if (at % 60 === 0) console.log(`${label}: ${at}/${simulationSeconds} simulated seconds`);
  }
  const simulated = await capture.finish();
  await context.close();
  let live = null;
  if (liveSeconds > 0) {
    const liveContext = await browser.newContext({
      viewport: { width: 1400, height: 900 },
      deviceScaleFactor: 1,
      recordVideo: { dir: resolve(output, "video"), size: { width: 1400, height: 900 } },
    });
    const livePage = await open(liveContext);
    const liveCapture = await recorder(livePage, "live");
    await livePage.evaluate(() => window.motionQualityLab.live(true));
    const liveEpochMs = performance.now();
    const events = [
      [0, { phase: "idle", scenario: "live-idle" }],
      [6, { phase: "user-speaking", scenario: "live-listening" }],
      [10, { phase: "assistant-speaking", scenario: "live-speech" }],
      [18, { gesture: "emphasize" }],
      [25, { phase: "interrupted", scenario: "live-interruption" }],
      [27, { phase: "user-speaking", scenario: "live-listening-return" }],
    ];
    let elapsed = 0;
    for (const [time, input] of events) {
      if (time >= liveSeconds) break;
      if (time > elapsed)
        await livePage.waitForTimeout(Math.max(0, liveEpochMs + time * 1000 - performance.now()));
      await liveCapture.drain();
      await livePage.screenshot({
        path: resolve(output, `live-${String(time).padStart(2, "0")}.png`),
      });
      await livePage.evaluate((value) => window.motionQualityLab.command(value), input);
      elapsed = time;
    }
    if (liveSeconds > elapsed)
      await livePage.waitForTimeout(
        Math.max(0, liveEpochMs + liveSeconds * 1000 - performance.now()),
      );
    await livePage.evaluate(() => window.motionQualityLab.live(false));
    live = await liveCapture.finish();
    const video = livePage.video();
    await liveContext.close();
    await video.saveAs(resolve(output, "live.webm"));
    console.log(`${label}: ${live.frameCount} live frames recorded`);
  }
  const sourceHashesAfter = await fingerprintSources();
  const sourcesUnchanged = JSON.stringify(sourceHashes) === JSON.stringify(sourceHashesAfter);
  const report = {
    label,
    root,
    revision: args.get("revision") ?? null,
    url,
    seed,
    createdAt: new Date().toISOString(),
    sourceHashes,
    sourceHashesAfter,
    sourcesUnchanged,
    assets: manifest,
    schedule,
    simulationSeconds,
    liveSeconds,
    errors,
    resources,
    warnings: [...new Set(warnings)],
    limitations: [
      "Synthetic conversation phase inputs, no spoken audio or speech alignment acceptance.",
      "Fixed-step run is simulation, not five minutes of real terminal work.",
      "Live film is isolated Chrome at wall-clock speed; no native compositor, terminal output load or scene effects.",
      "Point/contact proxies and spike candidates are diagnostics; no skin collision or naturalness certification.",
    ],
    summary: {
      simulatedFrames: simulated.frameCount,
      simulatedSuspectMoments: simulated.suspectMoments,
      liveFrames: live?.frameCount ?? 0,
      liveWallClock: live ? { ...live.wallClock, trace: undefined } : null,
    },
  };
  await writeFile(resolve(output, "manifest.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!sourcesUnchanged)
    throw new Error("Core motion or QA sources changed during capture; repeat on stable sources");
  if (errors.length || resources.length) throw new Error(JSON.stringify({ errors, resources }));
  console.log(`Evidence: ${output}`);
} finally {
  await browser.close();
  await server.close();
}
