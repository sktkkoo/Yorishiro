#!/usr/bin/env node
// Build-time asset bundling.
//
// Charminal の VRMA / voice asset は third-party 由来でリポジトリ同梱できない
// （詳細は CREDITS.md / README.md）。ローカル開発と build の前にこのスクリプトが
// 外部ストアから内部の所定パスへ copy する。
//
// 外部ストアの既定位置: `../Charminal-assets/`（worktree と同じ親に置く運用）
// 上書きしたい場合は env var `CHARMINAL_ASSETS_DIR` を設定する。

import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "..");

const externalRoot = process.env.CHARMINAL_ASSETS_DIR
  ? resolve(process.env.CHARMINAL_ASSETS_DIR)
  : resolve(REPO_ROOT, "..", "Charminal-assets");

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
  },
];

// 単体ファイルのコピー定義（directory sync ではなく 1:1 コピー）
const FILE_TARGETS = [
  {
    label: "bundled VRM (CLAI)",
    from: join(externalRoot, "models", "CLAI.vrm"),
    to: join(REPO_ROOT, "public", "models", "CLAI.vrm"),
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

async function syncFile({ label, from, to }) {
  if (!(await exists(from))) {
    console.warn(`  [skip] ${label}: source not found at ${from}`);
    return;
  }
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to);
  console.log(`  [ok]   ${label}: → ${to}`);
}

async function syncDir({ label, from, to }) {
  if (!(await exists(from))) {
    console.warn(`  [skip] ${label}: source not found at ${from}`);
    return { label, copied: 0, skipped: true };
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
  return { label, copied, skipped: false };
}

async function main() {
  console.log(`fetch-assets: external store = ${externalRoot}`);

  if (!(await exists(externalRoot))) {
    // Release builds must ship the full asset set: fail closed so a missing /
    // mis-downloaded store never produces an incomplete bundle.
    if (process.env.CHARMINAL_ASSETS_REQUIRED) {
      console.error(`
fetch-assets: external asset store not found, but CHARMINAL_ASSETS_REQUIRED is set.

Expected at: ${externalRoot}

This is a release/packaging build that must include third-party assets
(VRMA animations, voices, bundled VRM). Provide the store and retry:
  CHARMINAL_ASSETS_DIR=/path/to/assets npm run fetch-assets
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
  CHARMINAL_ASSETS_DIR=/path/to/assets npm run fetch-assets
`);
    return;
  }

  for (const target of TARGETS) {
    await syncDir(target);
  }

  for (const ft of FILE_TARGETS) {
    await syncFile(ft);
  }
}

main().catch((err) => {
  console.error("fetch-assets failed:", err);
  process.exit(1);
});
