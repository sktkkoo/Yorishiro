import type { HistoryAPI, SnapshotEntry } from "../../sdk/history";

/**
 * createHistoryApi の依存。binding（Tauri command）と確認 UX を注入する。
 * 注入式にすることで vitest から確認 dialog を fake に差し替えてテストできる。
 */
export interface HistoryApiDeps {
  readonly list: () => Promise<ReadonlyArray<SnapshotEntry>>;
  readonly create: (label?: string) => Promise<number>;
  readonly restore: (seq: number) => Promise<void>;
  /** 破壊的 restore の前に呼ぶ確認。true で続行（Finding #3 の確認 gate）。 */
  readonly confirm: (message: string) => Promise<boolean>;
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
      const approved = await deps.confirm(
        `最新の変更前（snapshot #${seq}）に ~/.charminal を戻します。よろしいですか？\n` +
          "packs / config.json / init.js を完全置換します（journal は変更しません）。",
      );
      if (!approved) return false;
      await deps.restore(seq);
      return true;
    },
  };
}
