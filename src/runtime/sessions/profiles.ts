/**
 * Bundled session profile と profile 解決 helper。
 *
 * Bundled profile (`shell` / `claude` / `codex`) は user の `profiles[]` 設定に
 * 関係なく常に使える。User profile が同じ id を宣言した場合は user 側が勝つ
 * （override 可能）。
 *
 * Internal design-record: 2026-05-05-multi-pane-terminal.md.
 */

import type { SessionProfile } from "./types";

/**
 * Bundled profile の正本。Charminal 本体が保証する 3 種類。
 *
 * `command` を null にしておくのは「spawn 側で profile.kind と profile.agent
 * から既定 binary を決めて」という意思表示。`shell` profile は `$SHELL`、
 * `claude` / `codex` profile はそれぞれ既定 binary を使う。
 */
const BUNDLED_PROFILES: ReadonlyArray<SessionProfile> = [
  {
    id: "shell",
    kind: "shell",
    command: null,
    args: [],
    env: {},
    cwd: null,
    agent: null,
    integration: true,
  },
  {
    id: "claude",
    kind: "agent",
    command: null,
    args: [],
    env: {},
    cwd: null,
    agent: "claude",
    integration: true,
  },
  {
    id: "codex",
    kind: "agent",
    command: null,
    args: [],
    env: {},
    cwd: null,
    agent: "codex",
    integration: true,
  },
];

/**
 * Bundled profile の id 一覧（`shell` / `claude` / `codex`）。
 */
export function listBundledProfiles(): ReadonlyArray<SessionProfile> {
  return BUNDLED_PROFILES;
}

/**
 * Bundled profile を id で取得。存在しなければ null。
 */
export function getBundledProfile(id: string): SessionProfile | null {
  return BUNDLED_PROFILES.find((p) => p.id === id) ?? null;
}

/**
 * User profile を優先し、なければ bundled に fall back。同 id の user profile
 * があれば bundled は隠れる（override semantics）。
 */
export function resolveProfile(
  id: string,
  userProfiles: ReadonlyArray<SessionProfile>,
): SessionProfile | null {
  return userProfiles.find((p) => p.id === id) ?? getBundledProfile(id);
}

/**
 * UI で「開ける profile 一覧」を出すための merged view。User profile が
 * bundled を override した場合、bundled 側は出さない。
 */
export function listAvailableProfiles(
  userProfiles: ReadonlyArray<SessionProfile>,
): ReadonlyArray<SessionProfile> {
  const userIds = new Set(userProfiles.map((p) => p.id));
  const bundledOnly = BUNDLED_PROFILES.filter((p) => !userIds.has(p.id));
  return [...userProfiles, ...bundledOnly];
}
