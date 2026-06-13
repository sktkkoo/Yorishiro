/**
 * LoadReport の build logic — pure fn。
 *
 * loadUserPacks の結果 + メタ情報（timestamp / safeMode）から、Rust 側が
 * `~/.charminal/last-startup.json` に atomic write する shape を組む。
 * Safe mode 時は loadUserPacks 自体を呼ばないため、この report の書き出しも
 * skip される（既存の last-startup.json が保持される）。
 *
 * Schema は spec 本文 Section 4.2 に準拠。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.2
 */

import type { FailedPackInfo, LoadedPackInfo, LoadUserPacksResult } from "./user-pack-loader";

export type PackKind = "persona" | "effect";

export interface LoadResultEntry {
  readonly id: string;
  readonly kind: string;
  readonly status: "loaded" | "failed";
  readonly error?: {
    readonly phase: "import" | "validate";
    readonly message: string;
  };
}

export interface LoadReport {
  readonly timestamp: string;
  readonly safeMode: boolean;
  readonly loadResults: ReadonlyArray<LoadResultEntry>;
}

export interface BuildLoadReportInput {
  readonly timestamp: string;
  readonly safeMode: boolean;
  readonly result: LoadUserPacksResult;
}

/**
 * error 文字列から phase を類推する。PackValidationError prefix があれば
 * validate、それ以外は import 扱い。runtime 側でさらに細かい分類が欲しく
 * なれば後から field を足せる形に留めている。
 */
const classifyPhase = (error: string): "import" | "validate" => {
  return error.startsWith("PackValidationError") ? "validate" : "import";
};

const successEntry = (info: LoadedPackInfo): LoadResultEntry => ({
  id: info.id,
  kind: info.kind,
  status: "loaded",
});

const failureEntry = (info: FailedPackInfo): LoadResultEntry => ({
  id: info.id,
  kind: info.kind,
  status: "failed",
  error: { phase: classifyPhase(info.error), message: info.error },
});

export function buildLoadReport(input: BuildLoadReportInput): LoadReport {
  const { timestamp, safeMode, result } = input;
  return {
    timestamp,
    safeMode,
    loadResults: [...result.loaded.map(successEntry), ...result.failed.map(failureEntry)],
  };
}
