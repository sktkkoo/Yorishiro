import { realpathSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { PiCredentialStore } from "./credential-store.mjs";
import { validateManagedIdentity } from "./managed-identity.mjs";
import { validatePermissions } from "./workspace-tools.mjs";

export class StartupError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export function parseOptions(args) {
  const required = ["session-dir", "cwd", "provider", "model", "permissions-json"];
  const names = new Set([...required, "auth-mode", "auth-path", "managed-identity-json"]);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    if (
      !args[index]?.startsWith("--") ||
      !names.has(key) ||
      values[key] !== undefined ||
      typeof args[index + 1] !== "string" ||
      !args[index + 1].trim()
    )
      throw new StartupError("configuration_invalid");
    values[key] = args[index + 1];
  }
  if (required.some((name) => values[name] === undefined))
    throw new StartupError("configuration_invalid");
  if (
    ![values.cwd, values["session-dir"]].every((path) => isAbsolute(path) && !path.includes("\0"))
  )
    throw new StartupError("configuration_invalid");
  let cwd;
  try {
    cwd = realpathSync(values.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error();
  } catch {
    throw new StartupError("configuration_invalid");
  }
  let permissions;
  try {
    permissions = validatePermissions(JSON.parse(values["permissions-json"]));
  } catch {
    throw new StartupError("permissions_invalid");
  }
  if (!["openai", "anthropic"].includes(values.provider))
    throw new StartupError("provider_unconfigured");
  const authMode = values["auth-mode"] ?? "apiKey";
  const authPath = values["auth-path"];
  if (
    !["apiKey", "oauth"].includes(authMode) ||
    (authMode === "oauth" &&
      (values.provider !== "openai" ||
        !authPath ||
        !isAbsolute(authPath) ||
        authPath.includes("\0"))) ||
    (authMode === "apiKey" && authPath !== undefined)
  )
    throw new StartupError("configuration_invalid");
  const options = {
    cwd,
    sessionDir: resolve(values["session-dir"]),
    provider: values.provider,
    model: values.model,
    permissions,
    authMode,
    authPath: authPath ?? null,
  };
  if (values["managed-identity-json"] !== undefined) {
    try {
      options.managedIdentity = validateManagedIdentity(
        JSON.parse(values["managed-identity-json"]),
        options,
      );
    } catch {
      throw new StartupError("configuration_invalid");
    }
  }
  return options;
}

// Resolve only the selected authentication mode. OAuth receives a Pi-owned
// store and disables environment API keys. There is no ambient CLI credential
// resolution, authentication fallback, or model catalog network refresh.
export function createConfiguredModels(options, environment = process.env, credentials) {
  const oauth = options.authMode === "oauth";
  const keyName = options.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  if (!["openai", "anthropic"].includes(options.provider))
    throw new StartupError("provider_unconfigured");
  if (oauth && (options.provider !== "openai" || !credentials))
    throw new StartupError("provider_unconfigured");
  const key = oauth ? undefined : environment[keyName];
  if (!oauth && (typeof key !== "string" || !key.trim()))
    throw new StartupError("provider_unconfigured");
  const models = createModels({
    ...(oauth ? { credentials } : {}),
    authContext: {
      env: async (name) => (!oauth && name === keyName ? key : undefined),
      fileExists: async () => false,
    },
  });
  models.setProvider(options.provider === "openai" ? openaiProvider() : anthropicProvider());
  if (!models.getModel(options.provider, options.model))
    throw new StartupError("model_unavailable");
  return models;
}

export async function openConfiguredModels(options, environment = process.env) {
  if ((options.authMode ?? "apiKey") === "apiKey")
    return {
      models: createConfiguredModels(options, environment),
      close: async () => {},
    };
  let store;
  try {
    store = new PiCredentialStore(options.authPath);
    const credential = await store.read("openai");
    if (credential?.type !== "oauth") throw new StartupError("provider_unconfigured");
    return {
      models: createConfiguredModels(options, {}, store),
      close: () => store.close(),
    };
  } catch (error) {
    await store?.close();
    if (error instanceof StartupError) throw error;
    throw new StartupError("auth_storage_unavailable");
  }
}
