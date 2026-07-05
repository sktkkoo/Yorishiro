/**
 * Time — 独立した時計 primitive。now / after / schedule / every / probability / afterJitter を提供する
 *
 * SDK surface: src/sdk/context.d.ts の Time interface（214–260）
 *
 * Phase 3.3(g.2) で TDD 実装。
 *
 * DI policy:
 *   - clock / random は constructor 経由で差し替え可能（test 決定性のため）
 *   - timer (setTimeout / setInterval) は Vitest fake timers を使う前提で非 DI
 */

import type { Cancellable, Time as SdkTime } from "@yorishiro/sdk";

export interface TimeDeps {
  clock?: () => number;
  random?: () => number;
}

export class Time implements SdkTime {
  private readonly clock: () => number;
  private readonly random: () => number;

  constructor(deps: TimeDeps = {}) {
    this.clock = deps.clock ?? Date.now;
    this.random = deps.random ?? Math.random;
  }

  now(): number {
    return this.clock();
  }

  after(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }

  schedule(ms: number, action: () => void): Cancellable {
    let cancelled = false;
    const handle = setTimeout(() => {
      if (cancelled) return;
      action();
    }, ms);

    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(handle);
      },
    };
  }

  every(interval: number, action: () => void): Cancellable {
    let cancelled = false;
    const handle = setInterval(() => {
      if (cancelled) return;
      action();
    }, interval);

    return {
      cancel: () => {
        if (cancelled) return;
        cancelled = true;
        clearInterval(handle);
      },
    };
  }

  probability(opts: { interval: number; probability: number; action: () => void }): Cancellable {
    return this.every(opts.interval, () => {
      if (this.random() < opts.probability) {
        opts.action();
      }
    });
  }

  afterJitter(min: number, max: number): Promise<void> {
    const delay = min + this.random() * (max - min);
    return this.after(delay);
  }
}
