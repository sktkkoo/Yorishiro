/**
 * @yorishiro/sdk/amenity-service
 *
 * Ambient UI が active amenity の明示的に公開された state / command を使うための
 * public capability boundary。AmenityPackRegistry や MCP tool handle は公開しない。
 *
 * Stable な共通 contract は `ctx.amenities.get(id)`、`getState()`、
 * `execute(command, params)` と、inactive 時に `get` が `null` を返すことだけ。
 * state shape、command 名・params・result は各 amenity が version 管理する。
 * subscribe、typed helper、community / isolated pack の permission model は
 * この共通 contract に含めない。
 */

/** Ambient UI に公開してよい state / command だけを持つ amenity 側 surface。 */
export interface AmenityServiceHandle {
  /** 現在の state snapshot。shape と互換性は amenity ごとの versioned contract。 */
  readonly getState: () => Promise<unknown>;

  /**
   * amenity が Ambient UI 向けに明示公開した command を実行する。
   * MCP tool 名・handler とは別 namespace で、未知の command は reject する。
   */
  readonly execute: (command: string, params?: unknown) => Promise<unknown>;
}

/** AmbientUiContext に注入される active amenity service resolver。 */
export interface AmenityServicesAPI {
  /** active かつ service を公開している amenity の handle。inactive 等では null。 */
  get(id: string): AmenityServiceHandle | null;
}
