const SUPPORTED_PACK_TYPES = new Set([
  "effect",
  "persona",
  "scene",
  "ui",
  "ambient-ui",
  "amenity",
  "utility",
]);
const EXECUTION_CLASSES = new Set(["declarative", "isolated-js", "trusted-main-thread-js"]);
const JS_LIKE_EXTENSIONS = [".js", ".mjs", ".ts", ".tsx"];
const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".ts", ".tsx"]);
const STYLE_EXTENSIONS = new Set([".css", ".html"]);
const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".ts",
  ".tsx",
  ".txt",
]);
export const MAX_PACK_FILE_BYTES = 100 * 1024 * 1024;
export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_SOURCE_PATTERNS = [
  ["forbidden-fetch", /\bfetch\s*\(/],
  ["forbidden-xhr", /\bXMLHttpRequest\b/],
  ["forbidden-websocket", /\bWebSocket\b/],
  ["forbidden-eval", /\beval\s*\(/],
  ["forbidden-function-constructor", /\bnew\s+Function\b|\bFunction\s*\(/],
  ["forbidden-tauri-api", /@tauri-apps\/api/],
  ["forbidden-node-fs", /(?:from\s+["'](?:node:)?fs["']|require\s*\(\s*["'](?:node:)?fs["']\s*\))/],
  [
    "forbidden-node-child-process",
    /(?:from\s+["'](?:node:)?child_process["']|require\s*\(\s*["'](?:node:)?child_process["']\s*\))/,
  ],
  ["forbidden-process", /\bprocess\./],
  ["forbidden-buffer", /\bBuffer\./],
  ["forbidden-system-exec", /\bsystem\.exec\b/],
  ["forbidden-pty-write", /\b(?:ptyWrite|write_terminal_input|terminal_prefill)\b/],
];
const UNSAFE_URL_PATTERN = /\b(?:https?|javascript|data|file|blob):/i;
const CSS_URL_PATTERN = /url\s*\(/i;
const PROTOTYPE_POLLUTION_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function createPackTextFile(text, size = text.length) {
  return { kind: "text", text, size };
}

export function createPackBinaryFile(size) {
  return { kind: "binary", size };
}

export function createPackSymlinkFile(size = 0) {
  return { kind: "symlink", size };
}

export function shouldReadPackTextFile(path, size) {
  return isTextPath(path) && size <= MAX_TEXT_FILE_BYTES;
}

export function checkPackFiles({ files, packDirName, mode = "local-authoring" }) {
  const diagnostics = [];
  const manifestFile = fileRecord(files.get("manifest.json"));

  if (manifestFile === undefined) {
    add(diagnostics, "error", "missing-manifest", "manifest.json is required");
    return result(mode, diagnostics);
  }

  scanFileMetadata(files, diagnostics);
  if (mode === "publish-candidate") {
    add(
      diagnostics,
      "warning",
      "publish-candidate-preview",
      "publish-candidate mode is a preview; official registry submission is not implemented and JS/TS scanning is heuristic",
    );
  }

  const manifestText = textFromFile(manifestFile);
  if (manifestText === null) {
    add(
      diagnostics,
      "error",
      "manifest-not-readable",
      "manifest.json must be a readable UTF-8 text file within the text size limit",
    );
    return result(mode, diagnostics);
  }

  const manifest = parseManifest(manifestText, diagnostics);
  if (manifest === null) return result(mode, diagnostics);

  validateManifest({ manifest, files, packDirName, mode, diagnostics });
  scanTextFiles(files, diagnostics);

  return result(mode, diagnostics);
}

function parseManifest(manifestText, diagnostics) {
  let parsed;
  try {
    parsed = JSON.parse(manifestText);
  } catch (error) {
    add(
      diagnostics,
      "error",
      "invalid-manifest-json",
      `manifest.json is invalid JSON: ${message(error)}`,
    );
    return null;
  }

  if (!isPlainObject(parsed)) {
    add(diagnostics, "error", "invalid-manifest", "manifest.json must contain a JSON object");
    return null;
  }

  scanPrototypePollutionKeys(parsed, "manifest.json", diagnostics);
  return parsed;
}

function validateManifest({ manifest, files, packDirName, mode, diagnostics }) {
  const id = stringField(manifest, "id", diagnostics);
  const type = stringField(manifest, "type", diagnostics);
  const entry = stringField(manifest, "entry", diagnostics);
  const executionClass = stringField(manifest, "executionClass", diagnostics);

  if (id !== null && packDirName !== "" && id !== packDirName) {
    add(
      diagnostics,
      "warning",
      "pack-id-dir-mismatch",
      `manifest id "${id}" does not match pack directory "${packDirName}"`,
    );
  }

  if (type !== null && !SUPPORTED_PACK_TYPES.has(type)) {
    add(diagnostics, "error", "unsupported-pack-type", `unsupported pack type "${type}"`);
  }

  if (type === "utility") {
    add(
      diagnostics,
      "error",
      "utility-disabled",
      "utility packs stay disabled until isolated-js runtime and permission UX exist",
    );
  }

  if (executionClass !== null && !EXECUTION_CLASSES.has(executionClass)) {
    add(
      diagnostics,
      "error",
      "unsupported-execution-class",
      `unsupported executionClass "${executionClass}"`,
    );
  }

  if (entry !== null) {
    validateEntry({ entry, executionClass, files, mode, diagnostics });
  }
}

function validateEntry({ entry, executionClass, files, mode, diagnostics }) {
  const normalizedEntry = normalizeRelativePath(entry);
  if (!isSafePackRelativePath(entry)) {
    add(diagnostics, "error", "unsafe-entry-path", `entry must be pack-relative: ${entry}`);
    return;
  }

  if (!files.has(normalizedEntry)) {
    add(diagnostics, "error", "missing-entry", `entry file does not exist: ${entry}`);
  }

  const jsLike = isJsLikePath(entry);
  if (executionClass === "declarative" && jsLike) {
    add(diagnostics, "error", "declarative-js-entry", "declarative packs must not use a JS entry");
  }

  if (executionClass === "isolated-js") {
    add(
      diagnostics,
      "error",
      "isolated-js-unimplemented",
      "isolated-js runtime is not implemented yet",
    );
  }

  if (mode === "publish-candidate" && executionClass === "trusted-main-thread-js") {
    add(
      diagnostics,
      "error",
      "trusted-main-thread-publish",
      "trusted-main-thread-js packs cannot be published as community artifacts",
    );
  }

  if (mode === "local-authoring" && executionClass === "trusted-main-thread-js" && jsLike) {
    add(
      diagnostics,
      "warning",
      "local-trusted-pack",
      "this is local trusted code, not a sandboxed or public-registry artifact",
    );
  }
}

function scanTextFiles(files, diagnostics) {
  for (const [path, rawFile] of files) {
    const file = fileRecord(rawFile);
    if (file === undefined || file.kind !== "text") continue;
    if (path === "manifest.json") continue;
    if (isSourcePath(path)) {
      scanSourceFile(path, file.text, diagnostics);
      continue;
    }
    if (isStylePath(path)) {
      scanStyleFile(path, file.text, diagnostics);
      continue;
    }
    if (isJsonPath(path)) {
      scanJsonFile(path, file.text, diagnostics);
    }
  }
}

function scanFileMetadata(files, diagnostics) {
  for (const [path, rawFile] of files) {
    const file = fileRecord(rawFile);
    if (file === undefined) continue;
    if (file.kind === "symlink") {
      add(diagnostics, "error", "symlink-entry", `${path} is a symlink`);
      continue;
    }
    if (file.size > MAX_PACK_FILE_BYTES) {
      add(
        diagnostics,
        "error",
        "file-too-large",
        `${path} exceeds the ${formatBytes(MAX_PACK_FILE_BYTES)} file size limit`,
      );
    }
    if (isTextPath(path) && file.kind !== "text" && file.size > MAX_TEXT_FILE_BYTES) {
      add(
        diagnostics,
        "error",
        "text-file-too-large",
        `${path} exceeds the ${formatBytes(MAX_TEXT_FILE_BYTES)} text scan limit`,
      );
    }
  }
}

function scanSourceFile(path, text, diagnostics) {
  if (UNSAFE_URL_PATTERN.test(text)) {
    add(diagnostics, "error", "unsafe-url", `${path} contains http/data/file/blob URL usage`);
  }
  if (CSS_URL_PATTERN.test(text)) {
    add(diagnostics, "error", "css-url", `${path} contains CSS url(...) usage`);
  }
  if (text.includes("../") || text.includes("..\\")) {
    add(diagnostics, "error", "path-traversal", `${path} contains parent-directory traversal`);
  }
  for (const [code, pattern] of FORBIDDEN_SOURCE_PATTERNS) {
    if (pattern.test(text)) {
      add(diagnostics, "error", code, `${path} contains ${code.replace("forbidden-", "")}`);
    }
  }
}

function scanStyleFile(path, text, diagnostics) {
  if (UNSAFE_URL_PATTERN.test(text)) {
    add(diagnostics, "error", "unsafe-url", `${path} contains http/data/file/blob URL usage`);
  }
  if (CSS_URL_PATTERN.test(text)) {
    add(diagnostics, "error", "css-url", `${path} contains CSS url(...) usage`);
  }
  if (text.includes("../") || text.includes("..\\")) {
    add(diagnostics, "error", "path-traversal", `${path} contains parent-directory traversal`);
  }
}

function scanJsonFile(path, text, diagnostics) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    add(diagnostics, "warning", "invalid-json-sidecar", `${path} is not valid JSON`);
    return;
  }
  scanPrototypePollutionKeys(parsed, path, diagnostics);
}

function fileRecord(rawFile) {
  if (rawFile === undefined) return undefined;
  if (rawFile === "__CHARMINAL_CHECK_PACK_SYMLINK__") {
    return createPackSymlinkFile();
  }
  if (typeof rawFile === "string") {
    return createPackTextFile(rawFile);
  }
  if (!isPlainObject(rawFile) || typeof rawFile.kind !== "string") {
    return undefined;
  }
  if (rawFile.kind === "text" && typeof rawFile.text === "string") {
    return createPackTextFile(rawFile.text, numberOrZero(rawFile.size));
  }
  if (rawFile.kind === "binary") {
    return createPackBinaryFile(numberOrZero(rawFile.size));
  }
  if (rawFile.kind === "symlink") {
    return createPackSymlinkFile(numberOrZero(rawFile.size));
  }
  return undefined;
}

function textFromFile(file) {
  return file.kind === "text" ? file.text : null;
}

function numberOrZero(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function formatBytes(bytes) {
  return `${Math.round(bytes / 1024 / 1024)} MiB`;
}

function scanPrototypePollutionKeys(value, path, diagnostics) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      scanPrototypePollutionKeys(item, `${path}[${index}]`, diagnostics);
    });
    return;
  }
  if (!isPlainObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    if (PROTOTYPE_POLLUTION_KEYS.has(key)) {
      add(diagnostics, "error", "prototype-pollution-key", `${path} contains unsafe key "${key}"`);
    }
    scanPrototypePollutionKeys(child, `${path}.${key}`, diagnostics);
  }
}

function stringField(object, key, diagnostics) {
  const value = object[key];
  if (typeof value === "string" && value.length > 0) return value;
  add(diagnostics, "error", `missing-${key}`, `manifest.${key} must be a non-empty string`);
  return null;
}

export function isSafePackRelativePath(path) {
  if (path === "") return false;
  if (path.startsWith("/") || path.startsWith("~")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return false;
  const clean = normalizeRelativePath(path);
  if (clean === "" || clean === "." || clean === "..") return false;
  return !clean.startsWith("../") && !clean.includes("/../");
}

function normalizeRelativePath(path) {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

function isJsLikePath(path) {
  const lower = path.toLowerCase();
  return JS_LIKE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

function isTextPath(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return TEXT_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function isSourcePath(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return SOURCE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function isStylePath(path) {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return STYLE_EXTENSIONS.has(path.slice(dot).toLowerCase());
}

function isJsonPath(path) {
  return path.toLowerCase().endsWith(".json");
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function add(diagnostics, severity, code, messageText) {
  diagnostics.push({ severity, code, message: messageText });
}

function result(mode, diagnostics) {
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === "warning");
  return { mode, ok: errors.length === 0, diagnostics, errors, warnings };
}

function message(error) {
  return error instanceof Error ? error.message : String(error);
}
