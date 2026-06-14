/**
 * Watcher event の pure 解釈層。
 *
 * Tauri invoke / dynamic import の impure 部分を持たないので、そのまま vitest
 * で検証できる。`~/.charminal/packs/<id>/<kind>.js` convention の parse と、
 * runtime-transpiled `~/.charminal/packs/<id>/{ui,scene}.tsx` の parse、
 * scene.tsx が relative import する nested source file の owner entry mapping、
 * file event → 何をすべきかの mapping に責任を限定する。
 *
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-b」Section B4
 */

import { SUPPORTED_PACK_KINDS } from "./supported-kinds";

export interface CharminalLayerEvent {
  readonly path: string;
  readonly kind: "created" | "modified" | "removed";
  readonly mtimeMs: number;
}

/** ~/.charminal/ 配下の path を意味ある unit にマップした結果。 */
export type ParsedLayerPath =
  | { readonly type: "pack"; readonly id: string; readonly kind: string }
  | { readonly type: "init" }
  | { readonly type: "ignore" };

/**
 * Watcher event が引き起こすべき action。handler 側はこの shape を見て
 * registry 操作や dynamic import を組み立てる。
 */
export type WatcherAction =
  | {
      readonly type: "reload-pack";
      readonly id: string;
      readonly kind: string;
      readonly entryPath: string;
      readonly mtimeMs: number;
    }
  | { readonly type: "remove-pack"; readonly id: string; readonly kind: string }
  | { readonly type: "init-changed"; readonly path: string }
  | { readonly type: "ignore"; readonly reason: string };

const stripTrailingSlash = (p: string): string => (p.endsWith("/") ? p.slice(0, -1) : p);
const TSX_ENTRY_KINDS = new Set(["ui", "scene"]);
const PACK_SOURCE_EXTENSIONS = [".tsx", ".ts", ".jsx", ".js"] as const;

const isPackSourceFile = (path: string): boolean =>
  PACK_SOURCE_EXTENSIONS.some((ext) => path.endsWith(ext));

function topLevelEntryPath(
  charminalHome: string,
  id: string,
  kind: string,
  extension: "js" | "tsx",
) {
  return `${stripTrailingSlash(charminalHome)}/packs/${id}/${kind}.${extension}`;
}

function isTopLevelEntryPath(
  path: string,
  charminalHome: string,
  id: string,
  kind: string,
): boolean {
  return (
    path === topLevelEntryPath(charminalHome, id, kind, "js") ||
    path === topLevelEntryPath(charminalHome, id, kind, "tsx")
  );
}

/**
 * `/Users/x/.charminal/packs/my-id/effect.js` → { type: "pack", id, kind }
 * `/Users/x/.charminal/packs/my-ui/ui.tsx` → { type: "pack", id, kind: "ui" }
 * `/Users/x/.charminal/packs/my-room/scene.tsx` → { type: "pack", id, kind: "scene" }
 * `/Users/x/.charminal/init.js` → { type: "init" }
 * nested source file → owner scene.tsx の reload action（mapEventToAction で処理）
 * その他 → { type: "ignore" }
 *
 * charminalHome は trailing slash の有無を問わない。
 */
export function parseLayerPath(absPath: string, charminalHome: string): ParsedLayerPath {
  const home = stripTrailingSlash(charminalHome);
  if (!absPath.startsWith(`${home}/`)) {
    return { type: "ignore" };
  }
  const relative = absPath.slice(home.length + 1);

  if (relative === "init.js") {
    return { type: "init" };
  }

  if (!relative.startsWith("packs/")) {
    return { type: "ignore" };
  }
  const afterPacks = relative.slice("packs/".length);
  const segments = afterPacks.split("/");
  if (segments.length < 2) {
    // packs/foo (pack dir itself) は ignore。
    return { type: "ignore" };
  }
  const [id, filename] = segments;
  if (id === "" || id.startsWith(".")) {
    return { type: "ignore" };
  }
  if (segments.length > 2) {
    const leaf = segments[segments.length - 1] ?? "";
    if (isPackSourceFile(leaf)) {
      return { type: "pack", id, kind: "scene" };
    }
    return { type: "ignore" };
  }
  let kind: string | null = null;
  if (filename.endsWith(".js")) {
    kind = filename.slice(0, -".js".length);
  } else if (filename.endsWith(".tsx")) {
    const tsxKind = filename.slice(0, -".tsx".length);
    kind = TSX_ENTRY_KINDS.has(tsxKind) ? tsxKind : null;
  }
  if (kind === null) {
    return { type: "ignore" };
  }
  if (!SUPPORTED_PACK_KINDS.has(kind)) {
    return { type: "ignore" };
  }
  return { type: "pack", id, kind };
}

/**
 * Watcher event を handler が消費できる action に落とす。`~/.charminal/packs/`
 * 配下の file event のみが意味を持つ action を生む。init.js は Phase 1-b では
 * reload しないが、将来のため separate action として返す。
 */
export function mapEventToAction(event: CharminalLayerEvent, charminalHome: string): WatcherAction {
  const parsed = parseLayerPath(event.path, charminalHome);
  if (parsed.type === "ignore") {
    return { type: "ignore", reason: "path not a known pack or init entry" };
  }
  if (parsed.type === "init") {
    return { type: "init-changed", path: event.path };
  }
  if (event.kind === "removed") {
    if (!isTopLevelEntryPath(event.path, charminalHome, parsed.id, parsed.kind)) {
      return {
        type: "reload-pack",
        id: parsed.id,
        kind: parsed.kind,
        entryPath: topLevelEntryPath(charminalHome, parsed.id, parsed.kind, "tsx"),
        mtimeMs: event.mtimeMs,
      };
    }
    return { type: "remove-pack", id: parsed.id, kind: parsed.kind };
  }
  if (!isTopLevelEntryPath(event.path, charminalHome, parsed.id, parsed.kind)) {
    return {
      type: "reload-pack",
      id: parsed.id,
      kind: parsed.kind,
      entryPath: topLevelEntryPath(charminalHome, parsed.id, parsed.kind, "tsx"),
      mtimeMs: event.mtimeMs,
    };
  }
  return {
    type: "reload-pack",
    id: parsed.id,
    kind: parsed.kind,
    entryPath: event.path,
    mtimeMs: event.mtimeMs,
  };
}
