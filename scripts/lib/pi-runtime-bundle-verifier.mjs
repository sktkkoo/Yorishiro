import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  assertNodeArchitecture,
  distribution,
  NODE_VERSION,
  PI_VERSION,
  resourceInventory,
  sha256,
} from "../prepare-pi-runtime.mjs";

/** Verify resources after Tauri copied and signed the sidecar into an app. */
export function verifyPiRuntimeBundle(appPath) {
  const worker = join(appPath, "Contents/Resources/resources/pi-worker");
  const node = join(appPath, "Contents/MacOS/yorishiro-pi-node");
  const manifest = JSON.parse(readFileSync(join(worker, "manifest.json"), "utf8"));
  if (
    manifest.version !== 1 ||
    manifest.nodeVersion !== NODE_VERSION ||
    manifest.piVersion !== PI_VERSION ||
    !manifest.target?.endsWith("-apple-darwin")
  )
    throw Error("Invalid bundled Pi runtime manifest");
  const artifact = distribution(manifest.target);
  if (
    manifest.nodeArchiveSha256 !== artifact.sha256 ||
    !manifest.files ||
    typeof manifest.files !== "object" ||
    Array.isArray(manifest.files)
  )
    throw Error("Unverified bundled Pi runtime provenance");
  for (const entry of [
    "main.mjs",
    "diagnose.mjs",
    "auth-main.mjs",
    "auth-login.mjs",
    "workspace-check.mjs",
    "package-lock.json",
    "licenses/Node-LICENSE.txt",
    "node_modules/@earendil-works/pi-ai/package.json",
    "node_modules/@earendil-works/pi-durable/package.json",
  ])
    if (!Object.hasOwn(manifest.files, entry)) throw Error("Missing bundled Pi runtime resource");
  for (const [name, hash] of Object.entries(manifest.files)) {
    if (
      isAbsolute(name) ||
      name.includes("\\") ||
      name.split("/").some((part) => !part || part === "." || part === "..") ||
      !/^[a-f0-9]{64}$/.test(hash)
    )
      throw Error("Unsafe bundled Pi runtime resource identity");
    const path = join(worker, name);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      relative(realpathSync(worker), realpathSync(path)).split(sep).includes("..") ||
      sha256(readFileSync(path)) !== hash
    )
      throw Error("Bundled Pi runtime resource failed integrity verification");
  }
  if (
    JSON.stringify(resourceInventory(worker)) !== JSON.stringify(manifest.files) ||
    sha256(readFileSync(join(worker, "package-lock.json"))) !== manifest.workerLockSha256
  )
    throw Error("Bundled Pi resource inventory differs from its manifest");
  const stat = lstatSync(node);
  if (!stat.isFile() || stat.isSymbolicLink() || !(stat.mode & 0o111))
    throw Error("Bundled Pi Node executable is unavailable");
  // Signing changes Mach-O bytes. Verify architecture and code signature, never
  // compare the pre-signing nodeBinarySha256 against a signed release sidecar.
  assertNodeArchitecture(readFileSync(node), artifact);
  return { node, worker, target: manifest.target, nodeVersion: manifest.nodeVersion };
}
