/**
 * leva の useControls と UiStateStore を双方向 bridge する hook.
 *
 * - leva → state: controls 値が変わるたびに UiStateStore.set() で同期.
 *   MCP の state_get で読めるようになる.
 * - state → leva: MCP が set_ui_state で値を書くと subscribe 経由で
 *   leva の set を呼び反映. user は leva panel で変化を見る.
 *
 * 無限ループ防止:
 *   UiStateStore.set() は Object.is(previous, value) で同値を無視.
 *   leva の set も同値で re-render しない. 両方のガードで自然に収束する.
 *
 * 使い方:
 *   const [controls, set] = useControls("store", () => ({ key: { value: 1 } }));
 *   useControlsBridge("packId", controls, set);
 */

import { useEffect } from "react";
import { getUiStateStore } from "./ui-state-store";

export function useControlsBridge(
  packId: string,
  controls: Record<string, unknown>,
  levaSet: (values: Record<string, unknown>) => void,
): void {
  const store = getUiStateStore();

  // leva → state: 毎 render で controls の全 key を state に書く.
  // UiStateStore.set は Object.is で同値を弾くため cost は低い.
  useEffect(() => {
    for (const [key, value] of Object.entries(controls)) {
      store.set(packId, key, value);
    }
  });

  // state → leva: MCP が state.set した値を leva に反映.
  // subscribe は初回に現在値で fire するが, 上の effect で既に同値が
  // 書かれているので levaSet(同値) → no-op.
  // controls を deps に入れると値変更のたびに再 subscribe するため意図的に省略.
  // biome-ignore lint/correctness/useExhaustiveDependencies: subscribe は key 名で 1 回だけ. controls 値の変更で再 subscribe しない
  useEffect(() => {
    const disposables: Array<{ dispose: () => void }> = [];
    for (const key of Object.keys(controls)) {
      const sub = store.subscribe(packId, key, (newValue) => {
        if (newValue !== undefined) {
          levaSet({ [key]: newValue });
        }
      });
      disposables.push(sub);
    }
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [packId, levaSet, store]);
}
