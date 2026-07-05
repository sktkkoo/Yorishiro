import { resolveProjectRoot } from "../../bindings/tauri-commands";
import {
  type CharminalConfig,
  resolveSceneForProject,
  withActiveSceneSet,
  withProjectSceneSet,
} from "../user-pack-loader/config";

/**
 * current project の唯一の入口。
 *
 * 今日は「起動時 cwd → 正規化 project root」だけを返すが、将来 project 階層
 * （design-record 2026-07-04 §4.3 の案 (b)）へ進む場合はここを差し替える。
 */
export async function resolveCurrentProjectRoot(cwd: string | null): Promise<string | null> {
  if (cwd === null) return null;
  try {
    return await resolveProjectRoot({ cwd });
  } catch {
    // project root 解決に失敗しても scene は global fallback に落ちるだけなので起動は続ける。
    return null;
  }
}

/**
 * current project が解決済みなら per-project mapping、未解決なら global activeScene を更新する。
 */
export function withCurrentProjectSceneSet(
  cfg: CharminalConfig,
  projectRoot: string | null,
  sceneId: string | null,
): CharminalConfig {
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
  cfg: CharminalConfig,
  projectRoot: string | null,
  sceneId: string | null,
): { readonly config: CharminalConfig; readonly activeScene: string | null } {
  const config = withCurrentProjectSceneSet(cfg, projectRoot, sceneId);
  return { config, activeScene: resolveSceneForProject(config, projectRoot) };
}
