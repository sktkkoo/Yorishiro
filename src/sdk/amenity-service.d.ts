/**
 * @yorishiro/sdk/amenity-service
 *
 * Ambient UI が active amenity の明示的に公開された state / command を使うための
 * public capability boundary。AmenityPackRegistry や MCP tool handle は公開しない。
 */

/** Ambient UI に公開してよい state / command だけを持つ amenity 側 surface。 */
export interface AmenityServiceHandle {
  /** 現在の state snapshot を返す。shape は amenity ごとの public contract。 */
  readonly getState: () => Promise<unknown>;

  /**
   * amenity が Ambient UI 向けに明示公開した command を実行する。
   * MCP tool 名・handler とは別 namespace で、未知の command は reject する。
   */
  readonly execute: (command: string, params?: unknown) => Promise<unknown>;
}

/** AmbientUiContext に注入される、active amenity service の read-only resolver。 */
export interface AmenityServicesAPI {
  /** active かつ service を公開している amenity の handle。該当しなければ null。 */
  get(id: string): AmenityServiceHandle | null;
}
