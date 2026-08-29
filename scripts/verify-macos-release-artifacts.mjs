import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const bundleRoot = resolve(process.argv[2] ?? "src-tauri/target/release/bundle");
const verificationScript = join(
  dirname(fileURLToPath(import.meta.url)),
  "verify-macos-signature.mjs",
);

if (process.platform !== "darwin") {
  console.error("macOS release artifacts can only be verified on macOS.");
  process.exit(1);
}

if (!existsSync(bundleRoot)) {
  console.error(`Bundle root not found: ${bundleRoot}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed with exit code ${result.status ?? 1}`);
  }
}

function walk(root, predicate, results = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (predicate(path, entry)) results.push(path);
      walk(path, predicate, results);
    } else if (entry.isFile() && predicate(path, entry)) {
      results.push(path);
    }
  }
  return results;
}

function findAppBundles(root, results = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (path.endsWith(".app")) {
      results.push(path);
    } else {
      findAppBundles(path, results);
    }
  }
  return results;
}

function exactlyOne(label, paths) {
  if (paths.length !== 1) {
    throw new Error(`Expected exactly one ${label}, found ${paths.length}: ${paths.join(", ")}`);
  }
  return paths[0];
}

function verifyApp(appPath) {
  run(process.execPath, [verificationScript, appPath, "--require-developer-id"]);
}

const updaterArchive = exactlyOne(
  "macOS updater archive",
  walk(bundleRoot, (path, entry) => entry.isFile() && path.endsWith(".app.tar.gz")),
);
const dmg = exactlyOne(
  "macOS DMG",
  walk(bundleRoot, (path, entry) => entry.isFile() && path.endsWith(".dmg")),
);
const scratch = mkdtempSync(join(tmpdir(), "yorishiro-release-verification-"));
if (
  dirname(scratch) !== resolve(tmpdir()) ||
  !basename(scratch).startsWith("yorishiro-release-verification-")
) {
  throw new Error(`Unexpected verification directory: ${scratch}`);
}
const updaterDirectory = join(scratch, "updater");
const dmgMount = join(scratch, "dmg");
let dmgMounted = false;

try {
  mkdirSync(updaterDirectory);
  run("tar", ["-xzf", updaterArchive, "-C", updaterDirectory]);
  const updaterApp = exactlyOne("app in the updater archive", findAppBundles(updaterDirectory));
  verifyApp(updaterApp);

  run("hdiutil", ["verify", dmg]);
  mkdirSync(dmgMount);
  run("hdiutil", ["attach", "-nobrowse", "-readonly", "-mountpoint", dmgMount, dmg]);
  dmgMounted = true;
  const dmgApp = exactlyOne("app in the DMG", findAppBundles(dmgMount));
  verifyApp(dmgApp);

  console.log(`Verified updater archive: ${updaterArchive}`);
  console.log(`Verified DMG: ${dmg}`);
} finally {
  try {
    if (dmgMounted) {
      run("hdiutil", ["detach", dmgMount]);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
