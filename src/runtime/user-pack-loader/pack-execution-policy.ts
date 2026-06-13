import { parsePackSandboxSpec } from "./pack-sandbox-spec";
import type { UserPackEntry } from "./user-pack-loader";

export type PackExecutionClass = "declarative" | "isolated-js" | "trusted-main-thread-js";

const JS_LIKE_ENTRY_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx"] as const;
const VALID_EXECUTION_CLASSES = new Set<PackExecutionClass>([
  "declarative",
  "isolated-js",
  "trusted-main-thread-js",
]);
const TRUSTED_MAIN_THREAD_SOURCES = new Set(["local", "curated", "bundled"]);

const basename = (path: string): string => {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
};

const isJsLikeEntry = (entry: string): boolean =>
  JS_LIKE_ENTRY_EXTENSIONS.some((ext) => entry.toLowerCase().endsWith(ext));

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export function normalizePackManifestSummary(raw: unknown): UserPackEntry["manifest"] | undefined {
  if (!isObject(raw)) return undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type: typeof raw.type === "string" ? raw.type : "",
    entry: typeof raw.entry === "string" ? raw.entry : "",
    executionClass: typeof raw.executionClass === "string" ? raw.executionClass : undefined,
    sandbox: raw.sandbox,
  };
}

export function validatePackExecutionPolicy(entry: UserPackEntry): string | null {
  const source = entry.source ?? "local";
  const manifest = entry.manifest;

  if (manifest === undefined) {
    if (source === "community") {
      return "community pack requires manifest.json with executionClass";
    }
    return null;
  }

  if (manifest.id !== entry.id) {
    return `manifest id "${manifest.id}" does not match pack id "${entry.id}"`;
  }
  if (manifest.type !== entry.kind) {
    return `manifest type "${manifest.type}" does not match discovered kind "${entry.kind}"`;
  }
  if (manifest.entry !== basename(entry.entryPath)) {
    return `manifest entry "${manifest.entry}" does not match discovered entry "${basename(entry.entryPath)}"`;
  }

  const executionClass = manifest.executionClass ?? "trusted-main-thread-js";
  if (!VALID_EXECUTION_CLASSES.has(executionClass as PackExecutionClass)) {
    return `unsupported executionClass "${executionClass}"`;
  }

  // sandbox 宣言は schema 検証のみ先行（Phase 0）。enforcement が無い backend は
  // 全て reject する（fail-closed）。Phase 1 で native、Phase 2 で wasm を解禁予定。
  if (manifest.sandbox !== undefined) {
    const { spec, error } = parsePackSandboxSpec(manifest.sandbox);
    if (error !== undefined) {
      return error;
    }
    return `sandbox backend "${spec?.backend}" is not implemented yet`;
  }

  if (executionClass === "declarative") {
    if (isJsLikeEntry(manifest.entry)) {
      return `declarative pack entry "${manifest.entry}" must not be JavaScript`;
    }
    return "declarative user pack data loader is not implemented yet";
  }

  if (executionClass === "isolated-js") {
    return "isolated-js runtime is not implemented yet";
  }

  if (executionClass === "trusted-main-thread-js" && !TRUSTED_MAIN_THREAD_SOURCES.has(source)) {
    return "trusted-main-thread-js is only allowed for local, curated, or bundled packs";
  }

  return null;
}

export async function readManifestForEntry(
  entryPath: string,
  deps: { readonly convertFileSrc: (filePath: string, protocol?: string) => string },
): Promise<UserPackEntry["manifest"] | undefined> {
  const packDir = entryPath.replace(/\/[^/]+$/, "");
  const manifestUrl = deps.convertFileSrc(`${packDir}/manifest.json`);
  try {
    const response = await fetch(manifestUrl, { cache: "no-store" });
    if (!response.ok) return undefined;
    return normalizePackManifestSummary(await response.json());
  } catch {
    return undefined;
  }
}
