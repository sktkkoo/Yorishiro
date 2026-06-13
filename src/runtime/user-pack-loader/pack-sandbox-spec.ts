/**
 * manifest の sandbox field（能力ラダー: wasm default / native escalation）。
 * Phase 0 では schema 定義と fail-closed 検証のみ。enforcement は
 * Phase 1（native / local system.exec）・Phase 2+（wasm runtime, 宣言反映）。
 * internal design-record: 2026-06-12-pack-store-sandbox-necessity-proposal.md Section 4.4
 */
export interface PackSandboxSpec {
  readonly backend: "wasm" | "native";
  readonly fs?: {
    readonly read?: readonly string[];
    readonly write?: readonly string[];
  };
  readonly net?: readonly string[];
  readonly runtime?: string;
}

const KNOWN_FIELDS = new Set(["backend", "fs", "net", "runtime"]);
const KNOWN_BACKENDS = new Set(["wasm", "native"]);
const KNOWN_FS_FIELDS = new Set(["read", "write"]);

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

/**
 * 不正・未知の形は error を返す（fail-closed）。「知らないものは通さない」が
 * 後方互換の要：古い client が新しい backend を黙って素通しすることを防ぐ。
 */
export function parsePackSandboxSpec(raw: unknown): {
  readonly spec?: PackSandboxSpec;
  readonly error?: string;
} {
  if (!isObject(raw)) {
    return { error: "sandbox must be an object" };
  }
  for (const key of Object.keys(raw)) {
    if (!KNOWN_FIELDS.has(key)) {
      return { error: `unknown sandbox field "${key}"` };
    }
  }

  const backend = raw.backend;
  if (typeof backend !== "string" || !KNOWN_BACKENDS.has(backend)) {
    return { error: `unknown sandbox backend "${String(backend)}"` };
  }

  let fs: PackSandboxSpec["fs"];
  if (raw.fs !== undefined) {
    if (!isObject(raw.fs)) return { error: "sandbox.fs must be an object" };
    for (const key of Object.keys(raw.fs)) {
      if (!KNOWN_FS_FIELDS.has(key)) {
        return { error: `unknown sandbox field "fs.${key}"` };
      }
    }

    const fsRead = raw.fs.read;
    const fsWrite = raw.fs.write;
    if (fsRead !== undefined && !isStringArray(fsRead)) {
      return { error: "sandbox.fs.read must be string[]" };
    }
    if (fsWrite !== undefined && !isStringArray(fsWrite)) {
      return { error: "sandbox.fs.write must be string[]" };
    }
    fs = {
      ...(fsRead !== undefined ? { read: fsRead } : {}),
      ...(fsWrite !== undefined ? { write: fsWrite } : {}),
    };
  }

  const net = raw.net;
  if (net !== undefined && !isStringArray(net)) {
    return { error: "sandbox.net must be string[]" };
  }
  const runtime = raw.runtime;
  if (runtime !== undefined && typeof runtime !== "string") {
    return { error: "sandbox.runtime must be a string" };
  }

  return {
    spec: {
      backend: backend as PackSandboxSpec["backend"],
      ...(fs !== undefined ? { fs } : {}),
      ...(net !== undefined ? { net } : {}),
      ...(runtime !== undefined ? { runtime } : {}),
    },
  };
}
