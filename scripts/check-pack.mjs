#!/usr/bin/env node

import { lstat, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { checkPackFiles } from "./lib/pack-checker.mjs";

const args = process.argv.slice(2);
const { mode, packDir } = parseArgs(args);

if (packDir === null) {
  printUsage();
  process.exitCode = 2;
} else {
  const result = await run(packDir, mode);
  printResult(packDir, result);
  process.exitCode = result.ok ? 0 : 1;
}

async function run(packDir, mode) {
  const absolutePackDir = path.resolve(packDir);
  const packDirName = path.basename(absolutePackDir);
  const files = await readPackFiles(absolutePackDir);
  return checkPackFiles({ files, packDirName, mode });
}

function parseArgs(rawArgs) {
  let mode = "local-authoring";
  const paths = [];

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--mode") {
      mode = rawArgs[index + 1] ?? "";
      index += 1;
    } else {
      paths.push(arg);
    }
  }

  if (mode !== "local-authoring" && mode !== "publish-candidate") {
    console.error(`Unsupported mode: ${mode}`);
    return { mode: "local-authoring", packDir: null };
  }

  return { mode, packDir: paths.length === 1 ? paths[0] : null };
}

async function readPackFiles(rootDir) {
  const files = new Map();
  await walk(rootDir, "", files);
  return files;
}

async function walk(rootDir, relativeDir, files) {
  const absoluteDir = path.join(rootDir, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "backup") {
      continue;
    }

    const relativePath = normalizePath(path.join(relativeDir, entry.name));
    const absolutePath = path.join(rootDir, relativePath);
    const stat = await lstat(absolutePath);

    if (stat.isSymbolicLink()) {
      files.set(relativePath, "__CHARMINAL_CHECK_PACK_SYMLINK__");
      continue;
    }
    if (entry.isDirectory()) {
      await walk(rootDir, relativePath, files);
      continue;
    }
    if (entry.isFile()) {
      files.set(relativePath, await readFile(absolutePath, "utf8"));
    }
  }
}

function printResult(packDir, result) {
  const status = result.ok ? "PASS" : "FAIL";
  console.log(`${status} ${packDir} (${result.mode})`);

  for (const diagnostic of result.diagnostics) {
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }

  if (result.diagnostics.length === 0) {
    console.log("No issues found.");
  }
}

function printUsage() {
  console.error(
    "Usage: npm run check:pack -- [--mode local-authoring|publish-candidate] <pack-dir>",
  );
}

function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}
