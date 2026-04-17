/**
 * VrmCache — URL → ArrayBuffer の LRU キャッシュ。
 *
 * raw bytes 保持の理由と trade-off、および統合点は
 * internal design-record: 2026-04-17-phase-2.5-vrm-blob-cache.md を参照。
 */
export interface VrmCache {
  /**
   * url のバイト列を取得する。cache miss なら fetch してキャッシュに入れて返す。
   * URL は `window.location.origin` に対して normalize してから key にする。
   *
   * @throws fetch が失敗した場合
   */
  getBytes(url: string): Promise<ArrayBuffer>;

  /** LRU 上限（既定 3）を変更。既存 entry が上限を超えていれば即 evict。 */
  setMaxEntries(n: number): void;

  /** 全 entry を削除（主にテスト / 手動 reset 用）。 */
  clear(): void;
}
