/**
 * Renderer — EffectContext.renderer に供給される RendererAPI の実装。
 *
 * SDK surface: src/sdk/context.d.ts の RendererAPI（584–595）
 * Philosophy: docs/philosophy/PRESENCE_HARNESS.md「六要素 > 空間」
 *
 * 本実装は Effect Pack からのみ呼ばれる。Effect の lifecycle に沿って
 * filter primitive を dispense する。SDK の規約上 addShakeFilter 等は
 * Disposable を返し、Effect が明示的に dispose するまで効果を継続する。
 *
 * 本バージョンは addShakeFilter のみ実装。他の primitive (addParticles /
 * addColorFilter / drawOnCanvas) は Effect Pack 需要に応じて順次追加。
 */

import type { Disposable, ParticleConfig, ParticleHandle, RendererAPI } from "@charminal/sdk";

const SHAKE_MAX_PX = 20;

export interface RendererDeps {
  /**
   * addShakeFilter が transform を書き込む対象。production では
   * document.body（body の transform は fixed 子孫の containing block を
   * 作るため、terminal + canvas が同時にシフトする）。test では stub。
   */
  readonly shakeTarget: HTMLElement;
  /** 乱数源。default Math.random。 */
  readonly random?: () => number;
}

export class Renderer implements RendererAPI {
  private readonly shakeTarget: HTMLElement;
  private readonly random: () => number;

  constructor(deps: RendererDeps) {
    this.shakeTarget = deps.shakeTarget;
    this.random = deps.random ?? Math.random;
  }

  addShakeFilter(intensity: number): Disposable {
    let disposed = false;
    const tick = (): void => {
      if (disposed) return;
      const dx = (this.random() - 0.5) * 2 * SHAKE_MAX_PX * intensity;
      const dy = (this.random() - 0.5) * 2 * SHAKE_MAX_PX * intensity;
      this.shakeTarget.style.transform = `translate(${dx}px, ${dy}px)`;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.shakeTarget.style.transform = "";
      },
    };
  }

  addColorFilter(_color: string, _opacity: number): Disposable {
    throw new Error("Renderer.addColorFilter: not yet implemented");
  }

  addParticles(_config: ParticleConfig): ParticleHandle {
    throw new Error("Renderer.addParticles: not yet implemented");
  }

  drawOnCanvas(_draw: (ctx: CanvasRenderingContext2D) => void): Disposable {
    throw new Error("Renderer.drawOnCanvas: not yet implemented");
  }
}
