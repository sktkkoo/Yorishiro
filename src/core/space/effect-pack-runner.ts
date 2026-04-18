/**
 * EffectPackRunner — Effect Pack (EffectDefinition) を EffectDispatcher に
 * bind する薄い runner。
 *
 * Philosophy: docs/philosophy/PRESENCE_HARNESS.md「六要素 > 空間」
 * SDK surface: src/sdk/effect.d.ts の EffectDefinition / EffectRunner
 *              src/sdk/context.d.ts の EffectContext（189–206）
 *
 * pack の register 時に dispatcher の対応 kind を subscribe し、request が
 * 来たら EffectContext を組み立てて pack.run を非同期で呼ぶ。pack の
 * lifetime（filter dispose 等）は pack.run 内部で time.after と組み合わせて
 * 管理する想定。
 *
 * Audio API は stub（MVP では voice 系は deferred）。
 */

import type {
  AudioPlayOptions,
  Disposable,
  EffectAudioAPI,
  EffectContext,
  EffectDefinition,
  RendererAPI,
} from "@charminal/sdk";
import type { Time } from "../time";
import type { EffectDispatcher } from "./effect-dispatcher";

const stubAudio: EffectAudioAPI = {
  play: async (_ref: string, _options?: AudioPlayOptions): Promise<void> => {},
};

export interface EffectPackRunnerDeps {
  readonly dispatcher: EffectDispatcher;
  /**
   * EffectContext.renderer にそのまま供給される SDK 側 interface。
   * production では `Renderer` class instance、test では RendererAPI stub が来る。
   * runner は RendererAPI より強い保証を必要としないので interface で受ける。
   */
  readonly renderer: RendererAPI;
  readonly time: Time;
  readonly audio?: EffectAudioAPI;
}

export class EffectPackRunner {
  private readonly dispatcher: EffectDispatcher;
  private readonly renderer: RendererAPI;
  private readonly time: Time;
  private readonly audio: EffectAudioAPI;

  constructor(deps: EffectPackRunnerDeps) {
    this.dispatcher = deps.dispatcher;
    this.renderer = deps.renderer;
    this.time = deps.time;
    this.audio = deps.audio ?? stubAudio;
  }

  /**
   * pack 側 author が TOptions を特定の request shape として宣言している前提で、
   * dispatcher から届く SpaceEffectRequest をそのまま options として渡す。
   * 型の橋渡しは `EffectDefinition<TOptions>` という「契約」で担保し、runtime
   * では構造チェックを通さない——型を narrow する責務は pack author 側。
   */
  register<TOptions = unknown>(pack: EffectDefinition<TOptions>): Disposable {
    const unsub = this.dispatcher.subscribe(pack.id, (request) => {
      const controller = new AbortController();
      const options = request as unknown as TOptions;
      const ctx: EffectContext<TOptions> = {
        options,
        time: this.time,
        signal: controller.signal,
        renderer: this.renderer,
        audio: this.audio,
      };
      void pack.run(ctx, options).catch((err) => {
        console.warn(`[EffectPackRunner] pack ${pack.id} threw`, err);
      });
    });
    return { dispose: unsub };
  }
}
