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
    console.error(`
fetch-assets: external asset store not found.

Expected at: ${externalRoot}

Set up the store with:
  mkdir -p ${externalRoot}/{animations,voices}
  # then place .vrma / voice files inside (see CREDITS.md for sources)

Or override the location:
  CHARMINAL_ASSETS_DIR=/path/to/assets npm run fetch-assets
`);
    process.exit(1);
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
