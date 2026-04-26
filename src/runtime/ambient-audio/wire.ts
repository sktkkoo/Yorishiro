/**
 * `initAmbientAudio` — AmbientAudioRuntime を ScenePackRegistry に bind する
 * lifecycle helper。
 *
 * Boot 時に一度呼び、registry の active scene 変化を購読する。Subscriber は
 * SceneSpec の `ambient` field を `setMix` 形式に変換して engine に流す。
 *
 * 解決済み URL を受け取る前提 (resolveSceneAssets が register 時に pre-resolve 済み)。
 *
 * Internal design-record: specs/2026-04-25-scene-ambient-audio-design.md §4.6
 */

import type { SceneSpec } from "../../sdk/scene";
import type { Disposable, ScenePackRegistry } from "../scene-pack-registry";
import { AmbientAudioRuntime, type ResolvedSound } from "./ambient-audio";

export interface InitResult {
  readonly engine: AmbientAudioRuntime;
  readonly dispose: () => void;
}

export function initAmbientAudio(registry: ScenePackRegistry): InitResult {
  const engine = new AmbientAudioRuntime();

  const apply = (scene: SceneSpec | null): void => {
    if (scene === null) {
      engine.setMix([]);
      return;
    }
    const resolved: ResolvedSound[] = (scene.ambient ?? []).map((a) => ({
      url: a.src,
      volume: a.volume ?? 1.0,
    }));
    engine.setMix(resolved);
  };

  const sub: Disposable = registry.subscribeActive(apply);

  return {
    engine,
    dispose: () => {
      sub.dispose();
      engine.stopAll();
    },
  };
}
