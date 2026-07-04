import { resolveProjectRoot } from "../../bindings/tauri-commands";
import {
  type CharminalConfig,
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
