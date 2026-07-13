#!/usr/bin/env node
// Build-time asset bundling.
//
// Yorishiro の VRMA / voice asset は third-party 由来でリポジトリ同梱できない
// （詳細は CREDITS.md / README.md）。ローカル開発と build の前にこのスクリプトが
// 外部ストアから内部の所定パスへ copy する。
//
// 外部ストアの既定位置: `../Yorishiro-assets/`（worktree と同じ親に置く運用）
// 上書きしたい場合は env var `YORISHIRO_ASSETS_DIR` を設定する。

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const externalRoot = process.env.YORISHIRO_ASSETS_DIR
  ? resolve(process.env.YORISHIRO_ASSETS_DIR)
  : resolve(REPO_ROOT, "..", "Yorishiro-assets");

const TARGETS = [
  {
    label: "animations",
    from: join(externalRoot, "animations"),
    to: join(REPO_ROOT, "public", "animations"),
  },
  {
    label: "voices",
    from: join(externalRoot, "voices"),
    to: join(REPO_ROOT, "bundled-packs", "shared", "voices"),
    // voice クリップは third-party 由来の任意アセット。CREDITS.md の通り本リリースでは
    // 非同梱で、ストアに voices/ が無いのが既定状態（voice-clip-resolver も present な
    // ときだけ解決する optional 設計）。存在すれば copy するが、不在でも packaging
    // build を止めない。必須なのは animations と bundled VRM のみ。
    optional: true,
  },
];

// 単体ファイルのコピー定義（directory sync ではなく 1:1 コピー）
const FILE_TARGETS = [
  {
    label: "bundled VRM (Yori)",
    from: join(externalRoot, "models", "Yori.vrm"),
    to: join(REPO_ROOT, "public", "models", "Yori.vrm"),
  },
];

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function syncFile({ label, from, to, optional = false }) {
  if (!(await exists(from))) {
    console.warn(`  [skip] ${label}: source not found at ${from}`);
    return { label, copied: 0, skipped: true, optional };
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
  console.log(`  [ok]   ${label}: → ${to}`);
  return { label, copied: 1, skipped: false, optional };
}

async function syncDir({ label, from, to, optional = false }) {
  if (!(await exists(from))) {
    console.warn(`  [skip] ${label}: source not found at ${from}`);
    return { label, copied: 0, skipped: true, optional };
  }

  // Clean target while preserving .gitkeep so the directory stays tracked.
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(to)) {
    if (entry === ".gitkeep") continue;
    await rm(join(to, entry), { recursive: true, force: true });
  }

  let copied = 0;
  for (const entry of await readdir(from)) {
    if (entry === ".DS_Store") continue;
    await cp(join(from, entry), join(to, entry), { recursive: true });
    copied += 1;
  }
  console.log(`  [ok]   ${label}: ${copied} entr${copied === 1 ? "y" : "ies"} → ${to}`);
  return { label, copied, skipped: false, optional };
}

async function main() {
  console.log(`fetch-assets: external store = ${externalRoot}`);
  const required = Boolean(process.env.YORISHIRO_ASSETS_REQUIRED);

  if (!(await exists(externalRoot))) {
    // Release builds must ship the full asset set: fail closed so a missing /
    // mis-downloaded store never produces an incomplete bundle.
    if (required) {
      console.error(`
fetch-assets: external asset store not found, but YORISHIRO_ASSETS_REQUIRED is set.

Expected at: ${externalRoot}

This is a release/packaging build that must include third-party assets
(VRMA animations, voices, bundled VRM). Provide the store and retry:
  YORISHIRO_ASSETS_DIR=/path/to/assets npm run fetch-assets
`);
      process.exit(1);
    }

    // Local dev / fresh clone / CI: degrade gracefully. The app still builds and
    // runs; character animation and voice are limited until assets are present.
    // See README "Setup" and CREDITS.md for how to obtain the third-party assets.
    console.warn(`
fetch-assets: external asset store not found — continuing without bundled assets.

Expected at: ${externalRoot}

The app will build and run, but character animation, voice, and the bundled VRM
will be limited. To enable them, place the third-party assets (see CREDITS.md)
under the store and re-run:
  mkdir -p ${externalRoot}/{animations,voices,models}
  YORISHIRO_ASSETS_DIR=/path/to/assets npm run fetch-assets
`);
    return;
  }

  const results = [];
  for (const target of TARGETS) {
    results.push(await syncDir(target));
  }

  for (const ft of FILE_TARGETS) {
    results.push(await syncFile(ft));
  }

  if (required) {
    // optional なターゲット（voices 等）の不在は許容し、必須アセットの欠落のみで止める。
    const missing = results.filter(
      (result) => !result.optional && (result.skipped || result.copied === 0),
    );
    if (missing.length > 0) {
      console.error(`
fetch-assets: required asset targets are missing:
${missing.map((result) => `  - ${result.label}`).join("\n")}

YORISHIRO_ASSETS_REQUIRED is set, so this packaging build must not continue
with an incomplete asset bundle. Repack or point YORISHIRO_ASSETS_DIR at a
complete Yorishiro-assets store and retry.
`);
      process.exit(1);
    }
  }
}

main().catch((err) => {
  console.error("fetch-assets failed:", err);
  process.exit(1);
});
