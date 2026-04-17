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
} from "@charminal/sdk";
import type { Time } from "../time";
import type { EffectDispatcher } from "./effect-dispatcher";
import type { Renderer } from "./renderer";

const stubAudio: EffectAudioAPI = {
  play: async (_ref: string, _options?: AudioPlayOptions): Promise<void> => {},
};

export interface EffectPackRunnerDeps {
  readonly dispatcher: EffectDispatcher;
  readonly renderer: Renderer;
  readonly time: Time;
  readonly audio?: EffectAudioAPI;
}

export class EffectPackRunner {
  private readonly dispatcher: EffectDispatcher;
  private readonly renderer: Renderer;
  private readonly time: Time;
  private readonly audio: EffectAudioAPI;

  constructor(deps: EffectPackRunnerDeps) {
    this.dispatcher = deps.dispatcher;
    this.renderer = deps.renderer;
    this.time = deps.time;
    this.audio = deps.audio ?? stubAudio;
  }

  register(pack: EffectDefinition): Disposable {
    const unsub = this.dispatcher.subscribe(pack.id, (request) => {
      const controller = new AbortController();
      const ctx: EffectContext = {
        options: request,
        time: this.time,
        signal: controller.signal,
        renderer: this.renderer,
        audio: this.audio,
      };
      void pack.run(ctx, request).catch((err) => {
        console.warn(`[EffectPackRunner] pack ${pack.id} threw`, err);
      });
    });
    return { dispose: unsub };
  }
}
