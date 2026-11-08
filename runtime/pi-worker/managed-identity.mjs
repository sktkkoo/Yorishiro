import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  COMMAND_PRESET_IDS,
  PROJECT_COMMAND_IDS,
  PROJECT_TIMEOUT_MS,
} from "./project-commands.mjs";

const keys = [
  "version",
  "runtime",
  "runtimeVersion",
  "workspaceKey",
  "familyKey",
  "stateKey",
  "generation",
  "provider",
  "model",
  "authMode",
  "permissions",
];
const hex = (value) => typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
const fail = () => {
  throw new Error("managed_identity_invalid");
};

export function protectedInstallationPaths(options) {
  const protectedPaths = options.authPath ? [dirname(options.authPath)] : [];
  if (options.managedIdentity) {
    // The selected workspace may be HOME. Protect all native preferences and
    // authoritative history, in addition to credentials and executable code.
    protectedPaths.push(
      dirname(dirname(dirname(options.authPath))),
      dirname(fileURLToPath(import.meta.url)),
      dirname(process.execPath),
    );
  }
  return protectedPaths;
}

/** Logical identities survive installing/moving the signed application. */
export function validateManagedIdentity(value, options, environment = {}) {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key)) ||
    value.version !== 2 ||
    value.runtime !== "bundled" ||
    value.runtimeVersion !== "pi-1.5.0/node-22.23.4" ||
    !hex(value.workspaceKey) ||
    !hex(value.familyKey) ||
    !hex(value.stateKey) ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 0 ||
    value.provider !== options.provider ||
    value.model !== options.model ||
    value.authMode !== "oauth" ||
    options.authMode !== "oauth"
  )
    fail();
  const policy = value.permissions;
  if (
    !policy ||
    typeof policy !== "object" ||
    Array.isArray(policy) ||
    Object.keys(policy).length !== 3 ||
    typeof policy.read !== "boolean" ||
    typeof policy.write !== "boolean" ||
    !Array.isArray(policy.commands) ||
    policy.commands.length > COMMAND_PRESET_IDS.length ||
    new Set(policy.commands).size !== policy.commands.length ||
    policy.commands.some((id) => !COMMAND_PRESET_IDS.includes(id))
  )
    fail();
  const cwd = realpathSync(options.cwd);
  if (createHash("sha256").update(cwd).digest("hex") !== value.workspaceKey) fail();
  const home = environment.home ?? join(homedir(), ".yorishiro");
  let session = join(home, "continuity/pi", value.stateKey);
  if (value.generation > 0) session = join(session, "generations", String(value.generation));
  if (realpathSync(options.sessionDir) !== realpathSync(session)) fail();
  if (realpathSync(options.authPath) !== realpathSync(join(home, "continuity/pi/auth.json")))
    fail();
  const node = realpathSync(environment.node ?? process.execPath);
  const checker = realpathSync(
    environment.checker ?? fileURLToPath(new URL("./workspace-check.mjs", import.meta.url)),
  );
  const expected = {
    read: policy.read,
    write: policy.write,
    commands: policy.commands.map((id) => ({
      id,
      program: node,
      args: [checker, id],
      ...(PROJECT_COMMAND_IDS.includes(id) ? { timeoutMs: PROJECT_TIMEOUT_MS } : {}),
    })),
  };
  if (!isDeepStrictEqual(options.permissions, expected)) fail();
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
