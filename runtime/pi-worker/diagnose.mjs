import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

const names = ["node", "configuration", "dependencies", "model", "authentication"];
const check = (name, status, code) => ({ name, status, code });

export function supportsNode(version) {
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) return false;
  const [major, minor] = version.split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 19);
}

async function loadDependencies() {
  // Import the production runtime dependencies without creating a Harness,
  // opening SQLite, resolving credentials, or refreshing a provider catalog.
  const [configuration, openai, anthropic] = await Promise.all([
    import("./config.mjs"),
    import("@earendil-works/pi-ai/providers/openai"),
    import("@earendil-works/pi-ai/providers/anthropic"),
    import("@earendil-works/chord/context"),
    import("@earendil-works/pi-durable/storage/sqlite/node"),
    import("@earendil-works/pi-schema"),
  ]);
  return {
    parseOptions: configuration.parseOptions,
    credentialMetadata: (await import("./credential-store.mjs")).credentialMetadata,
    providers: { openai: openai.openaiProvider, anthropic: anthropic.anthropicProvider },
  };
}

/** Offline readiness only: an existing key is not evidence that the service
 * accepts it. Dependencies are injectable solely for deterministic unit tests. */
export async function diagnose(args, dependencies = {}) {
  const {
    nodeVersion = process.versions.node,
    environment = process.env,
    load = loadDependencies,
  } = dependencies;
  const results = new Map();
  const set = (name, status, code) => results.set(name, check(name, status, code));
  const finish = () => {
    const checks = names.map((name) => results.get(name));
    return { protocol: 1, ready: checks.every((entry) => entry.status === "ok"), checks };
  };
  const block = (pending) => {
    for (const name of pending) set(name, "blocked", `${name}_blocked`);
    return finish();
  };

  // This gate deliberately precedes every non-builtin import, including config.
  if (!supportsNode(nodeVersion)) {
    set("node", "invalid", "node_unsupported");
    return block(names.slice(1));
  }
  set("node", "ok", "node_supported");
  let runtime;
  try {
    runtime = await load();
    set("dependencies", "ok", "dependencies_available");
  } catch (error) {
    const missing = ["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(error?.code);
    set(
      "dependencies",
      missing ? "missing" : "invalid",
      missing ? "dependencies_missing" : "dependencies_invalid",
    );
    return block(["configuration", "model", "authentication"]);
  }
  let options;
  try {
    options = runtime.parseOptions(args);
    set("configuration", "ok", "configuration_valid");
  } catch {
    set("configuration", "invalid", "configuration_invalid");
    return block(["model", "authentication"]);
  }
  try {
    const provider = runtime.providers[options.provider]();
    const available = provider.getModels().some((model) => model.id === options.model);
    set("model", available ? "ok" : "missing", available ? "model_available" : "model_unavailable");
  } catch {
    set("model", "missing", "model_unavailable");
  }
  if (options.authMode === "oauth") {
    try {
      const metadata = await runtime.credentialMetadata(options.authPath);
      if (metadata.present && metadata.type !== "oauth")
        set("authentication", "invalid", "authentication_invalid");
      else
        set(
          "authentication",
          metadata.present ? "ok" : "missing",
          metadata.present ? "authentication_present" : "authentication_missing",
        );
    } catch {
      set("authentication", "invalid", "authentication_invalid");
    }
  } else {
    const keyName = options.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
    const present = typeof environment[keyName] === "string" && !!environment[keyName].trim();
    set(
      "authentication",
      present ? "ok" : "missing",
      present ? "authentication_present" : "authentication_missing",
    );
  }
  return finish();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  const report = await diagnose(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
