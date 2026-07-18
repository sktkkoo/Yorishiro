/**
 * Persona pack 同梱 avatar.vrm の解決。
 *
 * 「pack dir の avatar.vrm = その persona の姿」規約の runtime 側。
 * user pack のみ対象——bundled persona は同梱宣言を持たず、姿は引き継がれる。
 * decision: docs/decisions/persona-two-axes.md（VRM は world 軸ではなく
 * persona 付属アセットとして扱う）
 */

export const PERSONA_AVATAR_FILENAME = "avatar.vrm";

export interface AvatarVrmDeps {
  /** PersonaRegistry の entry lookup（listEntries から find する thin adapter）。 */
  readonly getEntry: (
    id: string,
  ) => { readonly origin: "bundled" | "user"; readonly entryPath?: string } | undefined;
  /**
   * path に有効な VRM が存在するか（Rust `probe_vrm`）。
   * 不在は false、存在するが VRM として不正なら throw。
   */
  readonly probeVrm: (path: string) => Promise<boolean>;
}

/**
 * persona pack dir の avatar.vrm の絶対パスを返す。宣言が無ければ null。
 * avatar.vrm が存在するのに VRM として不正な場合は throw する
 * （呼び出し側が「切替は続行、姿だけ据え置き」の best-effort で拾う）。
 */
export async function resolvePersonaAvatarVrm(
  deps: AvatarVrmDeps,
  personaId: string,
): Promise<string | null> {
  const entry = deps.getEntry(personaId);
  if (entry === undefined || entry.origin !== "user" || entry.entryPath === undefined) {
    return null;
  }
  const packDir = entry.entryPath.replace(/\/[^/]+$/, "");
  const candidate = `${packDir}/${PERSONA_AVATAR_FILENAME}`;
  return (await deps.probeVrm(candidate)) ? candidate : null;
}
