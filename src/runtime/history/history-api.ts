import type { HistoryAPI, SnapshotEntry } from "../../sdk/history";

/**
 * createHistoryApi の依存。binding（Tauri command）と確認 UX を注入する。
 * 注入式にすることで vitest から確認 dialog を fake に差し替えてテストできる。
 */
export interface HistoryApiDeps {
  readonly list: () => Promise<ReadonlyArray<SnapshotEntry>>;
  readonly create: (label?: string) => Promise<number>;
  readonly restore: (seq: number) => Promise<void>;
  /**
   * restore の確認 UX。UI 側が restore 本体まで所有し、成功時は reload する。
   * true なら restore が実行された、false なら user が閉じた。
   */
  readonly confirmRestore: (seq: number, runRestore: () => Promise<void>) => Promise<boolean>;
}

/**
 * HistoryAPI の実体。restore は confirm を経てから raw restore を呼ぶ。
 * MCP restore handler と amenity ctx の両方がこの 1 つの実装を共用する（対称性）。
 */
export function createHistoryApi(deps: HistoryApiDeps): HistoryAPI {
  return {
    list: () => deps.list(),
    snapshot: (label) => deps.create(label),
    restore: async (seq: number): Promise<boolean> => {
      return deps.confirmRestore(seq, () => deps.restore(seq));
    },
  };
}
