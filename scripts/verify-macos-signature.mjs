import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";
import {
  macosSignatureErrors,
  REQUIRED_MACOS_ENTITLEMENTS,
} from "./lib/macos-signature-verifier.mjs";

const args = process.argv.slice(2);
const requireDeveloperId = args.includes("--require-developer-id");
const positionalArgs = args.filter((arg) => !arg.startsWith("--"));
const unknownFlags = args.filter((arg) => arg.startsWith("--") && arg !== "--require-developer-id");
const appPath = positionalArgs[0] ?? "src-tauri/target/release/bundle/macos/Yorishiro.app";

if (positionalArgs.length > 1 || unknownFlags.length > 0) {
  console.error(
    "Usage: node scripts/verify-macos-signature.mjs [app-path] [--require-developer-id]",
  );
  process.exit(2);
}

if (process.platform !== "darwin") {
  console.error("macOS code signatures can only be verified on macOS.");
  process.exit(1);
}

if (!existsSync(appPath)) {
  console.error(`App bundle not found: ${appPath}`);
  console.error("Build it first with: npm run build:macos:app");
  process.exit(1);
}

function run(command, commandArgs) {
  const result = spawnSync(command, commandArgs, { encoding: "utf8" });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    console.error(output.trim());
    process.exit(result.status ?? 1);
  }
  return output;
}

run("codesign", ["--verify", "--deep", "--strict", "--verbose=4", appPath]);
const signatureDetails = run("codesign", [
  "--display",
  "--verbose=4",
  "--entitlements",
  "-",
  "--xml",
  appPath,
]);
const errors = macosSignatureErrors(signatureDetails, { requireDeveloperId });

if (errors.length > 0) {
  console.error(errors.join("\n"));
  console.error(signatureDetails.trim());
  process.exit(1);
}

if (requireDeveloperId) {
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", appPath]);
  run("xcrun", ["stapler", "validate", appPath]);
}

console.log(`Valid macOS signature: ${appPath}`);
console.log(`Signed entitlements: ${REQUIRED_MACOS_ENTITLEMENTS.join(", ")}`);
console.log(
  requireDeveloperId
    ? "Release trust: Developer ID, secure timestamp, Gatekeeper, and notarization verified"
    : "Signing mode: local (Developer ID was not required)",
);
