/**
 * app-updater — tauri-plugin-updater の薄い wrapper。
 *
 * GitHub Releases に添付された latest.json（.github/workflows/release.yml が生成）を
 * 確認し、更新があれば署名検証つきでダウンロード・適用して relaunch する。
 * plugin module は動的 import で遅延読み込みし、check の失敗
 * （非 Tauri 文脈 / ネットワーク不達）は「更新なし」として静かに扱う——
 * 更新確認は user の作業を邪魔しない背景動作であって、失敗を騒ぐ種類のものではない。
 * 一方 installAndRelaunch の失敗は user が押したボタンの結果なので caller に伝播させる。
 */

export interface AvailableUpdate {
  /** 更新先の version（例: "0.6.0"）。 */
  readonly version: string;
  /**
   * ダウンロード・適用して再起動する。進捗は 0-1 の比率で通知
   * （contentLength 不明時は null = 不定表示）。
   */
  installAndRelaunch(onProgress?: (ratio: number | null) => void): Promise<void>;
}

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  let update: Awaited<ReturnType<typeof import("@tauri-apps/plugin-updater").check>>;
  try {
    const { check } = await import("@tauri-apps/plugin-updater");
    update = await check();
  } catch {
    return null;
  }
  if (!update) return null;

  const { version } = update;
  return {
    version,
    async installAndRelaunch(onProgress) {
      let total: number | null = null;
      let received = 0;
      await update.downloadAndInstall((event) => {
        switch (event.event) {
          case "Started":
            total = event.data.contentLength ?? null;
            onProgress?.(total === null ? null : 0);
            break;
          case "Progress":
            received += event.data.chunkLength;
            onProgress?.(total === null ? null : Math.min(received / total, 1));
            break;
          case "Finished":
            onProgress?.(1);
            break;
        }
      });
      const { relaunch } = await import("@tauri-apps/plugin-process");
      await relaunch();
    },
  };
}
