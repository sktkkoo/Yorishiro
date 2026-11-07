#!/usr/bin/env node
/** Build-time only: stage a pinned Node sidecar and self-contained Pi resources. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "22.23.4";
export const PI_VERSION = "1.5.0";
// Source: https://nodejs.org/dist/v22.23.4/SHASUMS256.txt
export const NODE_DISTRIBUTIONS = Object.freeze({
  "aarch64-apple-darwin": {
    platform: "darwin",
    arch: "arm64",
    sha256: "c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428",
  },
  "x86_64-apple-darwin": {
    platform: "darwin",
    arch: "x64",
    sha256: "efcc2b0db6f94bf53eddb038fe2b370277a042bd29e4f19b8f8e23598795b819",
  },
  "aarch64-unknown-linux-gnu": {
    platform: "linux",
    arch: "arm64",
    sha256: "f7a1e486dbc8b286847815b477d4fb5e9fb963ed4489c3e1588853d685f589f9",
  },
  "x86_64-unknown-linux-gnu": {
    platform: "linux",
    arch: "x64",
    sha256: "b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406",
  },
});
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_BINARY_BYTES = 200 * 1024 * 1024;

export function distribution(target) {
  const artifact = NODE_DISTRIBUTIONS[target];
  if (!artifact) throw new Error("Unsupported Pi runtime target");
  const prefix = `node-v${NODE_VERSION}-${artifact.platform}-${artifact.arch}`;
  return {
    ...artifact,
    target,
    prefix,
    filename: `${prefix}.tar.gz`,
    url: `https://nodejs.org/dist/v${NODE_VERSION}/${prefix}.tar.gz`,
  };
}

export function hostTarget(platform = process.platform, arch = process.arch) {
  const key = `${platform}:${arch}`;
  const targets = {
    "darwin:arm64": "aarch64-apple-darwin",
    "darwin:x64": "x86_64-apple-darwin",
    "linux:arm64": "aarch64-unknown-linux-gnu",
    "linux:x64": "x86_64-unknown-linux-gnu",
  };
  if (!targets[key])
    throw new Error("Pi runtime is supported on macOS and Linux development hosts");
  return targets[key];
}

export function parseArguments(args, environment = process.env) {
  let target = environment.TAURI_ENV_TARGET_TRIPLE || hostTarget();
  let check = false;
  for (let index = 0; index < args.length; index++) {
    if (args[index] === "--check") check = true;
    else if (args[index] === "--target" && args[index + 1]) target = args[++index];
    else if (args[index].startsWith("--target=")) target = args[index].slice(9);
    else throw new Error("Usage: prepare-pi-runtime.mjs [--target <Rust target>] [--check]");
  }
  distribution(target);
  return { target, check };
}

function run(program, args, options = {}) {
  const result = spawnSync(program, args, {
    encoding: "buffer",
    maxBuffer: MAX_BINARY_BYTES,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(`Pi runtime preparation command failed: ${basename(program)}`);
  return result.stdout;
}

export function validateArchiveNames(names, prefix) {
  if (!names.length) throw new Error("Empty Node archive");
  for (const name of names) {
    const segments = name.replace(/\/$/, "").split("/");
    if (
      isAbsolute(name) ||
      name.includes("\\") ||
      segments[0] !== prefix ||
      segments.some((part) => !part || part === "." || part === "..")
    )
      throw new Error("Unsafe Node archive member");
  }
  for (const entry of ["bin/node", "LICENSE"]) {
    if (names.filter((name) => name === `${prefix}/${entry}`).length !== 1)
      throw new Error("Missing or duplicate Node archive member");
  }
}

export function extractNodeArchive(archive, artifact, runner = run) {
  const names = runner("tar", ["-tzf", archive], { maxBuffer: 8 * 1024 * 1024 })
    .toString("utf8")
    .trim()
    .split("\n");
  validateArchiveNames(names, artifact.prefix);
  // Extract exactly two trusted names to stdout: tar never writes archive paths.
  const node = runner("tar", ["-xOzf", archive, `${artifact.prefix}/bin/node`]);
  const license = runner("tar", ["-xOzf", archive, `${artifact.prefix}/LICENSE`], {
    maxBuffer: 1024 * 1024,
  });
  if (!node.length || node.length > MAX_BINARY_BYTES || !license.length)
    throw new Error("Invalid Node archive payload");
  assertNodeArchitecture(node, artifact);
  return { node, license };
}

export function assertNodeArchitecture(node, artifact) {
  if (node.length < 24) throw new Error("Invalid Node executable");
  const valid =
    artifact.platform === "darwin"
      ? node.readUInt32LE(0) === 0xfeedfacf &&
        node.readUInt32LE(4) === (artifact.arch === "arm64" ? 0x100000c : 0x1000007)
      : node.subarray(0, 6).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1])) &&
        node.readUInt16LE(18) === (artifact.arch === "arm64" ? 183 : 62);
  if (!valid) throw new Error("Node executable architecture does not match its target");
}

async function download(url) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(120_000) });
  if (!response.ok || !response.body) throw new Error("Could not download the pinned Node runtime");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) throw new Error("Node runtime archive is too large");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function sourceFiles(worker) {
  const manifest = JSON.parse(readFileSync(join(worker, "package.json"), "utf8"));
  const files = [...new Set(["package.json", "package-lock.json", ...manifest.files])];
  if (
    files.some(
      (name) =>
        typeof name !== "string" ||
        isAbsolute(name) ||
        name.includes("..") ||
        name.includes("\\") ||
        name.includes("*") ||
        name.endsWith(".node-test.mjs"),
    )
  )
    throw new Error("Worker package must list only production files");
  for (const name of files)
    if (!lstatSync(join(worker, name)).isFile() || lstatSync(join(worker, name)).isSymbolicLink())
      throw new Error("Missing regular worker source file");
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-durable",
    "@earendil-works/pi-schema",
    "@earendil-works/chord",
  ])
    if (manifest.dependencies?.[name] !== PI_VERSION)
      throw new Error("Pi dependencies must remain pinned");
  return files;
}

export function resourceInventory(root) {
  const files = {};
  function visit(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      const name = relative(root, file).split(sep).join("/");
      if (entry.isSymbolicLink()) throw new Error("Unexpected symlink in staged worker");
      if (entry.isDirectory()) visit(file);
      else if (entry.isFile() && name !== "manifest.json") {
        if (name.endsWith(".node"))
          throw new Error("Native addon cannot be cross-packaged without target verification");
        files[name] = sha256(readFileSync(file));
      } else if (!entry.isFile()) throw new Error("Unexpected special staged worker file");
    }
  }
  visit(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function preparedRuntime(root, target) {
  try {
    const artifact = distribution(target);
    const worker = join(root, "runtime/pi-worker");
    const staged = join(root, "src-tauri/resources/pi-worker");
    const sidecar = join(root, "src-tauri/binaries", `yorishiro-pi-node-${target}`);
    const manifest = JSON.parse(readFileSync(join(staged, "manifest.json"), "utf8"));
    if (
      manifest.version !== 1 ||
      manifest.target !== target ||
      manifest.nodeVersion !== NODE_VERSION ||
      manifest.piVersion !== PI_VERSION ||
      manifest.nodeArchiveSha256 !== artifact.sha256 ||
      manifest.workerLockSha256 !== sha256(readFileSync(join(worker, "package-lock.json")))
    )
      return false;
    const stat = lstatSync(sidecar);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !(stat.mode & 0o111) ||
      sha256(readFileSync(sidecar)) !== manifest.nodeBinarySha256
    )
      return false;
    assertNodeArchitecture(readFileSync(sidecar), artifact);
    verifyPiDependencies(staged);
    for (const name of sourceFiles(worker))
      if (manifest.files[name] !== sha256(readFileSync(join(worker, name)))) return false;
    return JSON.stringify(resourceInventory(staged)) === JSON.stringify(manifest.files);
  } catch {
    return false;
  }
}

function installProductionDependencies(stage) {
  const args = ["ci", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"];
  const npm = process.env.npm_execpath;
  if (npm) run(process.execPath, [npm, ...args], { cwd: stage });
  else run(process.platform === "win32" ? "npm.cmd" : "npm", args, { cwd: stage });
  // CLI links are unnecessary at runtime and are not portable bundle resources.
  rmSync(join(stage, "node_modules/.bin"), { recursive: true, force: true });
}

function verifyPiDependencies(stage) {
  for (const name of [
    "@earendil-works/pi-ai",
    "@earendil-works/pi-durable",
    "@earendil-works/pi-schema",
    "@earendil-works/chord",
  ]) {
    const path = join(stage, "node_modules", name, "package.json");
    if (
      !lstatSync(path).isFile() ||
      lstatSync(path).isSymbolicLink() ||
      JSON.parse(readFileSync(path, "utf8")).version !== PI_VERSION
    )
      throw new Error("Staged Pi dependency is missing or unpinned");
  }
}

export async function prepareRuntime({
  root = projectRoot,
  target = hostTarget(),
  cache = join(homedir(), ".cache/yorishiro/pi-runtime"),
  fetchArchive = download,
  installDependencies = installProductionDependencies,
  extractArchive = extractNodeArchive,
} = {}) {
  const artifact = distribution(target);
  root = resolve(root);
  if (preparedRuntime(root, target)) return { target, cached: true };
  const worker = join(root, "runtime/pi-worker");
  const files = sourceFiles(worker);
  mkdirSync(cache, { recursive: true });
  const archive = join(cache, artifact.filename);
  let bytes = existsSync(archive) ? readFileSync(archive) : null;
  if (bytes && sha256(bytes) !== artifact.sha256)
    throw new Error("Cached Node archive checksum mismatch");
  if (!bytes) {
    bytes = await fetchArchive(artifact.url);
    if (bytes.length > MAX_ARCHIVE_BYTES || sha256(bytes) !== artifact.sha256)
      throw new Error("Node archive checksum mismatch");
    const temporary = `${archive}.${randomUUID()}.tmp`;
    writeFileSync(temporary, bytes, { flag: "wx" });
    renameSync(temporary, archive);
  }
  const payload = extractArchive(archive, artifact);
  return stageVerifiedRuntime({ root, target, payload, installDependencies, files });
}

/** Separate fixture seam; the CLI calls this only after archive hash validation. */
export function stageVerifiedRuntime({
  root,
  target,
  payload,
  installDependencies = installProductionDependencies,
  files = sourceFiles(join(root, "runtime/pi-worker")),
}) {
  const artifact = distribution(target);
  assertNodeArchitecture(payload.node, artifact);
  const worker = join(root, "runtime/pi-worker");
  const resources = join(root, "src-tauri/resources");
  const binaries = join(root, "src-tauri/binaries");
  mkdirSync(resources, { recursive: true });
  mkdirSync(binaries, { recursive: true });
  const stage = join(resources, `.pi-worker-${randomUUID()}`);
  mkdirSync(stage);
  try {
    for (const name of files) {
      mkdirSync(dirname(join(stage, name)), { recursive: true });
      copyFileSync(join(worker, name), join(stage, name));
    }
    installDependencies(stage);
    verifyPiDependencies(stage);
    mkdirSync(join(stage, "licenses"));
    writeFileSync(join(stage, "licenses/Node-LICENSE.txt"), payload.license);
    const manifest = {
      version: 1,
      nodeVersion: NODE_VERSION,
      piVersion: PI_VERSION,
      target,
      nodeArchiveSha256: artifact.sha256,
      nodeBinarySha256: sha256(payload.node),
      workerLockSha256: sha256(readFileSync(join(worker, "package-lock.json"))),
      files: resourceInventory(stage),
    };
    writeFileSync(join(stage, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const sidecar = join(binaries, `yorishiro-pi-node-${target}`);
    const temporaryNode = `${sidecar}.${randomUUID()}.tmp`;
    writeFileSync(temporaryNode, payload.node, { flag: "wx", mode: 0o755 });
    chmodSync(temporaryNode, 0o755);
    renameSync(temporaryNode, sidecar);
    const destination = join(resources, "pi-worker");
    const previous = `${destination}.previous-${randomUUID()}`;
    if (existsSync(destination)) renameSync(destination, previous);
    try {
      renameSync(stage, destination);
    } catch (error) {
      if (existsSync(previous)) renameSync(previous, destination);
      throw error;
    }
    if (existsSync(previous)) rmSync(previous, { recursive: true });
    return { target, cached: false, files: Object.keys(manifest.files).length };
  } finally {
    if (existsSync(stage)) rmSync(stage, { recursive: true });
  }
}

let directEntry = false;
try {
  directEntry =
    Boolean(process.argv[1]) &&
    realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
} catch {
  /* Imported by an inline/stdin tool, not invoked as the entry. */
}
if (directEntry) {
  try {
    const { target, check } = parseArguments(process.argv.slice(2));
    if (check) {
      if (!preparedRuntime(projectRoot, target))
        throw new Error("Pinned Pi runtime is not prepared; run npm run prepare:pi-runtime");
      console.log(JSON.stringify({ ready: true, target }));
    } else console.log(JSON.stringify(await prepareRuntime({ target })));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
