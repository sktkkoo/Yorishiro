import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import process from "node:process";

const appPath = process.argv[2] ?? "src-tauri/target/release/bundle/macos/Yorishiro.app";

if (process.platform !== "darwin") {
  console.error("macOS code signatures can only be verified on macOS.");
  process.exit(1);
}

if (!existsSync(appPath)) {
  console.error(`App bundle not found: ${appPath}`);
  console.error("Build it first with: npm run build:macos:app");
  process.exit(1);
}

function runCodesign(args) {
  const result = spawnSync("codesign", args, { encoding: "utf8" });
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

// Keep these equivalent to the commands documented in the release checklist.
runCodesign(["--verify", "--deep", "--strict", appPath]);
const entitlements = runCodesign(["-d", "--entitlements", ":-", appPath]);

const requiredEntitlements = [
  "com.apple.security.cs.allow-jit",
  "com.apple.security.cs.allow-unsigned-executable-memory",
  "com.apple.security.network.client",
  "com.apple.security.device.audio-input",
];

function hasEnabledEntitlement(plist, entitlement) {
  const escaped = entitlement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`<key>\\s*${escaped}\\s*</key>\\s*<true\\s*/>`).test(plist);
}

const missing = requiredEntitlements.filter(
  (entitlement) => !hasEnabledEntitlement(entitlements, entitlement),
);

if (missing.length > 0) {
  console.error(`Missing signed entitlements: ${missing.join(", ")}`);
  console.error(entitlements.trim());
  process.exit(1);
}

console.log(`Valid macOS signature: ${appPath}`);
console.log(`Signed entitlements: ${requiredEntitlements.join(", ")}`);
