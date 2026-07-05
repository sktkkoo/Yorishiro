import { resolveProjectRoot } from "../../bindings/tauri-commands";
import {
  resolveSceneForProject,
  withActiveSceneSet,
  withProjectSceneSet,
  type YorishiroConfig,
} from "../user-pack-loader/config";

export type ProjectRootResolution =
  | { readonly kind: "resolved"; readonly root: string }
  | { readonly kind: "none" }
  | { readonly kind: "unresolved"; readonly cwd: string; readonly error: string };

export function projectRootValue(resolution: ProjectRootResolution): string | null {
  return resolution.kind === "resolved" ? resolution.root : null;
}

export type ProjectSceneSelectionResult =
  | {
      readonly kind: "persisted";
      readonly config: YorishiroConfig;
      readonly activeScene: string | null;
      readonly projectRoot: ProjectRootResolution;
    }
  | {
      readonly kind: "runtime-only";
      readonly activeScene: string | null;
      readonly projectRoot: ProjectRootResolution;
      readonly warning: string;
    };

const PROJECT_ROOT_UNRESOLVED_SCENE_WARNING =
  "project root resolution failed; scene selection was applied at runtime only";

/**
 * current project の唯一の入口。
 *
 * 今日は「起動時 cwd → 正規化 project root」だけを返すが、将来 project 階層
 * （design-record 2026-07-04 §4.3 の案 (b)）へ進む場合はここを差し替える。
 */
export async function resolveCurrentProjectRoot(
  cwd: string | null,
): Promise<ProjectRootResolution> {
  if (cwd === null) return { kind: "none" };
  try {
    return { kind: "resolved", root: await resolveProjectRoot({ cwd }) };
  } catch (err) {
    // project root 解決失敗は「project なし」ではなく「不明」。scene 書き込み時に再試行し、
    // 失敗が続く場合は config write を避ける。
    return { kind: "unresolved", cwd, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function resolveProjectRootIfUnresolved(
  resolution: ProjectRootResolution,
): Promise<ProjectRootResolution> {
  return resolution.kind === "unresolved" ? resolveCurrentProjectRoot(resolution.cwd) : resolution;
}

/**
 * current project root があれば per-project mapping、無ければ global activeScene を更新する。
 */
export function withCurrentProjectSceneSet(
  cfg: YorishiroConfig,
  projectRoot: string | null,
  sceneId: string | null,
): YorishiroConfig {
  return projectRoot !== null
    ? withProjectSceneSet(cfg, projectRoot, sceneId)
    : withActiveSceneSet(cfg, sceneId);
}

/**
 * current project 向け scene 選択を書き込んだ後、runtime に即反映すべき実効 scene を返す。
 *
 * project mapping を null で消す場合は global activeScene に fallback するため、
 * raw sceneId ではなく更新後 config から解決する必要がある。
 */
export function applyCurrentProjectSceneSelection(
  cfg: YorishiroConfig,
  projectRoot: string | null,
  sceneId: string | null,
): { readonly config: YorishiroConfig; readonly activeScene: string | null } {
  const config = withCurrentProjectSceneSet(cfg, projectRoot, sceneId);
  return { config, activeScene: resolveSceneForProject(config, projectRoot) };
}

/**
 * current project 解決が一時失敗している場合、scene 書き込み直前に一度だけ再解決する。
 * それでも不明なら global activeScene を汚さず、runtime 反映だけに劣化する。
 */
export async function applyCurrentProjectSceneSelectionWithResolution(
  cfg: YorishiroConfig,
  projectRoot: ProjectRootResolution,
  sceneId: string | null,
): Promise<ProjectSceneSelectionResult> {
  const resolvedProjectRoot = await resolveProjectRootIfUnresolved(projectRoot);
  if (resolvedProjectRoot.kind === "unresolved") {
    return {
      kind: "runtime-only",
      activeScene: sceneId,
      projectRoot: resolvedProjectRoot,
      warning: PROJECT_ROOT_UNRESOLVED_SCENE_WARNING,
    };
  }

  const updated = applyCurrentProjectSceneSelection(
    cfg,
    projectRootValue(resolvedProjectRoot),
    sceneId,
  );
  return { kind: "persisted", ...updated, projectRoot: resolvedProjectRoot };
}
