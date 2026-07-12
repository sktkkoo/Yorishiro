import { parsePackSandboxSpec } from "./pack-sandbox-spec";
import type { UserPackEntry } from "./user-pack-loader";

export type PackExecutionClass = "declarative" | "isolated-js" | "trusted-main-thread-js";
export type PackPlatform = "macos" | "windows" | "linux";

export interface PackExecutionEnvironment {
  readonly clientVersion: string;
  readonly platform: PackPlatform;
}

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

const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z][0-9A-Za-z.-]*))?$/;

type ParsedSemver = readonly [number, number, number, readonly string[]];

const parseSemver = (value: string): ParsedSemver | null => {
  const match = SEMVER_RE.exec(value);
  if (match === null) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3]), match[4]?.split(".") ?? []];
};

const compareSemver = (left: ParsedSemver, right: ParsedSemver): number => {
  if (left[0] !== right[0]) return left[0] - right[0];
  if (left[1] !== right[1]) return left[1] - right[1];
  if (left[2] !== right[2]) return left[2] - right[2];
  const leftPre = left[3];
  const rightPre = right[3];
  if (leftPre.length === 0 || rightPre.length === 0) {
    return leftPre.length === rightPre.length ? 0 : leftPre.length === 0 ? 1 : -1;
  }
  const length = Math.max(leftPre.length, rightPre.length);
  for (let index = 0; index < length; index += 1) {
    const leftId = leftPre[index];
    const rightId = rightPre[index];
    if (leftId === undefined || rightId === undefined) {
      return leftId === rightId ? 0 : leftId === undefined ? -1 : 1;
    }
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) return Number(leftId) - Number(rightId);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId < rightId ? -1 : 1;
  }
  return 0;
};

export function normalizeClientPlatform(value: string): PackPlatform | null {
  const normalized = value.toLowerCase();
  if (normalized.includes("mac")) return "macos";
  if (normalized.includes("win")) return "windows";
  if (normalized.includes("linux")) return "linux";
  return null;
}

export function normalizePackManifestSummary(raw: unknown): UserPackEntry["manifest"] | undefined {
  if (!isObject(raw)) return undefined;
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    type: typeof raw.type === "string" ? raw.type : "",
    entry: typeof raw.entry === "string" ? raw.entry : "",
    executionClass: typeof raw.executionClass === "string" ? raw.executionClass : undefined,
    minClientVersion: typeof raw.minClientVersion === "string" ? raw.minClientVersion : undefined,
    platform: Array.isArray(raw.platform)
      ? raw.platform.filter((value): value is string => typeof value === "string")
      : undefined,
    sandbox: raw.sandbox,
  };
}

export function validatePackExecutionPolicy(
  entry: UserPackEntry,
  environment?: PackExecutionEnvironment,
): string | null {
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

  // NOTE: source は現状 discovery で常に "local" 固定（src-tauri/src/lib.rs の
  // discover_user_pack_entries）。pack がどう届いたかを記録する install 経路が
  // 未実装のため、この community/curated 排除は forward-scaffolding であって
  // 到達可能な enforcement ではない（source が "local" 以外になる経路が無い）。
  // 実 enforcement には host 所有の provenance ledger（受信側で source を assign。
  // pack 自身の manifest の自己申告は信じない）が要る。docs/security.md の
  // "Current enforcement status" 参照。
  if (executionClass === "trusted-main-thread-js" && !TRUSTED_MAIN_THREAD_SOURCES.has(source)) {
    return "trusted-main-thread-js is only allowed for local, curated, or bundled packs";
  }

  if (manifest.minClientVersion !== undefined) {
    const requiredVersion = parseSemver(manifest.minClientVersion);
    const currentVersion = environment?.clientVersion;
    const clientVersion = currentVersion ? parseSemver(currentVersion) : null;
    if (requiredVersion === null || clientVersion === null || clientVersion === undefined) {
      return `pack requires Yorishiro ${manifest.minClientVersion} or newer, but the client version is unavailable or invalid`;
    }
    if (compareSemver(clientVersion, requiredVersion) < 0) {
      return `pack requires Yorishiro ${manifest.minClientVersion} or newer (current: ${currentVersion})`;
    }
  }

  if (manifest.platform !== undefined) {
    if (environment === undefined) {
      return `pack is restricted to platform(s) ${manifest.platform.join(", ")}, but the client platform is unavailable`;
    }
    if (!manifest.platform.includes(environment.platform)) {
      return `pack does not support platform "${environment.platform}" (allowed: ${manifest.platform.join(", ")})`;
    }
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
