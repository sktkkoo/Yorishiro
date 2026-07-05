/**
 * Bundled session profile と profile 解決 helper。
 *
 * Bundled profile (`shell` / `claude` / `codex` / `opencode`) は user の `profiles[]` 設定に
 * 関係なく常に使える。User profile が同じ id を宣言した場合は user 側が勝つ
 * （override 可能）。
 *
 * Internal design-record: 2026-05-05-multi-pane-terminal.md.
 */

import type { SessionProfile } from "./types";

/**
 * Bundled profile の正本。Yorishiro 本体が保証する profile 群。
 *
 * `command` を null にしておくのは「spawn 側で profile.kind と profile.agent
 * から既定 binary を決めて」という意思表示。`shell` profile は `$SHELL`、
 * agent profile はそれぞれ adapter の既定 binary を使う。
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
  {
    id: "opencode",
    kind: "agent",
    command: null,
    args: [],
    env: {},
    cwd: null,
    agent: "opencode",
    integration: true,
  },
];

/**
 * Bundled profile の id 一覧。
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
 * 起動時に実際に使われる agent id を解決する。
 *
 * `defaultProfile` が agent profile を指していればその agent が勝ち、それ以外
 * （未指定 / shell profile / 解決不能）なら legacy `terminalAgent` に fall back
 * する。App.tsx の bootstrap と health-check が同じ解決を共有するための正本。
 *
 * shell profile が default の場合でも `terminalAgent`（agent pane を開くときに
 * 使う agent）を返す。これは bootstrap 側の挙動と一致する。
 */
export function resolveEffectiveAgent(config: {
  readonly terminalAgent: string;
  readonly defaultProfile: string | null;
  readonly profiles: ReadonlyArray<SessionProfile>;
}): string {
  if (config.defaultProfile !== null) {
    const profile = resolveProfile(config.defaultProfile, config.profiles);
    if (profile?.kind === "agent" && profile.agent !== null) {
      return profile.agent;
    }
  }
  return config.terminalAgent;
}

/**
 * `defaultProfile` が agent profile を指していれば、その profile id を返す。
 * 指していない（未指定 / shell profile / 解決不能）なら null。
 *
 * Settings の agent dropdown が `defaultProfile` によって固定されているか
 * （= terminalAgent の変更が起動 agent に効かない状態か）の判定に使う。
 */
export function resolveDefaultAgentProfileId(config: {
  readonly defaultProfile: string | null;
  readonly profiles: ReadonlyArray<SessionProfile>;
}): string | null {
  if (config.defaultProfile === null) {
    return null;
  }
  const profile = resolveProfile(config.defaultProfile, config.profiles);
  return profile?.kind === "agent" && profile.agent !== null ? config.defaultProfile : null;
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
