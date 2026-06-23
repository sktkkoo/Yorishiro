import { useSyncExternalStore } from "react";
import { type LightingMood, lightingMoodFromAggregate } from "./lighting-mood";
import { getWorkspaceAttentionStore } from "./workspace-attention-store";

/**
 * Scene が `WorkspaceAttentionAggregate` を照明 mood として購読する optional な consumer hook。
 *
 * これは「天気」層の唯一の配線口。host singleton の workspace-attention store を subscribe し、
 * aggregate を純関数 {@link lightingMoodFromAggregate} で正規化 modifier に変換して返す。
 *
 * 契約（design-record §4「照明のガードレール」）:
 * - **opt-in**: この hook を呼ばない scene の照明は一切変わらない。照明を「出すか出さないか」は
 *   scene が決める（aura/VRM のように host が強制しない）。
 * - **aggregate-only**: item 列・primary item は読まない。集約 mood だけを読む。
 * - **subtle・slow は scene 側**: 返すのは離散・即時の目標 mood。実際の照明への反映で「slow」
 *   （ゆっくり遷移）にするのは scene が useFrame 等で lerp して行う。hook は目標値の提供に徹し、
 *   照明そのものを掴まない（scene ownership を壊さない）。
 *
 * 返り値の {@link LightingMood} は warmth/brightness を [0,1] の相対値で持つ。scene は自身の
 * warm/cool・明暗レンジへこの値を map する。calm のときは neutral 中点なので scene の baseline
 * を歪めない（default 不変）。
 */
export function useWorkspaceLightingMood(): LightingMood {
  const store = getWorkspaceAttentionStore();
  const aggregate = useSyncExternalStore(
    (onChange) => {
      const sub = store.subscribe(() => onChange());
      return () => sub.dispose();
    },
    () => store.getAggregate(),
    () => store.getAggregate(),
  );
  return lightingMoodFromAggregate(aggregate);
}
