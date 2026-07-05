# src/runtime/ambient-audio/ — Scene Pack の ambient sound 再生

Scene Pack の declarative な `ambient` 宣言を Howler.js で再生する engine + ScenePackRegistry との配線。

## 公開 surface

- `AmbientAudioRuntime` — engine 本体 (`setMix(sounds)`, `stopAll()`)
- `initAmbientAudio(registry)` — boot 時に一度呼び、registry を購読

## Files

| file | 責務 |
|---|---|
| `ambient-audio.ts` | Howl instance を diff-based で manage、500ms crossfade。Re-add 時は fading-out 中の Howl を resurrect |
| `sound-resolver.ts` | `'sound:<name>'` の shared library lookup と fail-fast duplicate guard |
| `wire.ts` | `subscribeActive` 経由で SceneSpec.ambient を engine に流す |

## 関連

- 仕様: `Yorishiro-design-record/specs/2026-04-25-scene-ambient-audio-design.md`
- 上位 system: `src/runtime/scene-pack-registry/`
- Shared library: `bundled-packs/shared/sounds/`
