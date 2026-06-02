/**
 * @charminal/sdk/history
 *
 * Pack rollback の history API。~/.charminal/.history/ の full-copy snapshot を
 * 列挙・作成・復元する。AmenityContext 経由で amenity pack 作者に、MCP
 * `history_*` 経由で住人 AI に等しく公開する（対称性原則・SELF_REFERENTIAL_MCP）。
 *
 * ⚠️ restore は破壊的（full-replace）。実装は確認 UX を経てから戻す。
 * journal / memories は復元対象外（常に preserve）。config.json / init.js を
 * 含む復元はアプリ再読み込みが必要（hot-reload されない）。
 */

export interface SnapshotEntry {
  /** 単調増加の世代番号。restore の引数に使う。 */
  readonly seq: number;
  /**
   * 採番時刻（ms epoch）。Rust `SnapshotEntry` の serde field 名がそのまま
   * 出るため snake_case（index.json との互換のため camelCase 化しない）。
   */
  readonly ts_ms: number;
  /** "watcher-settled" | "startup-baseline" | "mcp:snapshot" など。 */
  readonly trigger: string;
  /** user / AI が付けた任意ラベル。 */
  readonly label?: string;
  /** 直前 startup が clean だったかの advisory ラベル（startup-baseline のみ付く）。 */
  readonly startup_clean?: boolean;
}

export interface HistoryAPI {
  /** snapshot 一覧（新しい順）。 */
  list(): Promise<ReadonlyArray<SnapshotEntry>>;
  /** 現在の ~/.charminal を 1 枚 snapshot し、seq を返す。 */
  snapshot(label?: string): Promise<number>;
  /**
   * seq の snapshot に full-replace で戻す。確認 UX を経て、戻したら true、
   * ユーザーが拒否したら false。config.json / init.js を含む場合は反映に
   * 再読み込みが必要。
   */
  restore(seq: number): Promise<boolean>;
}
