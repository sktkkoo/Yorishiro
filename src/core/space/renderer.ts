/**
 * Renderer — EffectContext.renderer に供給される RendererAPI の実装。
 *
 * SDK surface: src/sdk/context.d.ts の RendererAPI（584–595）
 *
 * 本実装は Effect Pack からのみ呼ばれる。Effect の lifecycle に沿って
 * filter primitive を dispense する。SDK の規約上 addShakeFilter 等は
 * Disposable を返し、Effect が明示的に dispose するまで効果を継続する。
 *
 * 本バージョンは addShakeFilter / addCssFilter / drawOnCanvas を実装。
 * addParticles は Effect Pack 需要に応じて順次追加。
 */

import type {
  CameraMoveConfig,
  Disposable,
  ParticleConfig,
  ParticleHandle,
  RendererAPI,
  TerminalCellData,
  Vec3,
} from "@yorishiro/sdk";
import { computeShakeOffset } from "./shake";

/**
 * addShakeFilter の default 減衰時間。Effect pack 側で dispose 前に
 * time.after(≈500ms) を挟むと旧 Charminal 相当の感触になる。
 */
const DEFAULT_SHAKE_DECAY_MS = 500;

/**
 * drawOnCanvas / addDomLayer が作る overlay の z-index。
 * terminal / VRM より前面に出る必要があり、かつ system UI とは
 * 重ならない桁で揃えた。
 */
const OVERLAY_Z_INDEX = 9999;

/**
 * drawOnCanvas が作る canvas に当てる固定 style。全画面 overlay で
 * pointer イベントを透過させる。
 */
const CANVAS_OVERLAY_STYLES: Readonly<Record<string, string>> = {
  position: "fixed",
  inset: "0",
  width: "100vw",
  height: "100vh",
  pointerEvents: "none",
  zIndex: String(OVERLAY_Z_INDEX),
};

/**
 * addDomLayer が作る div に当てる固定 style。drawOnCanvas と同じ
 * overlay 原則（全画面 fixed / pointer 透過 / z-index 9999）。
 */
const DOM_OVERLAY_STYLES: Readonly<Record<string, string>> = {
  position: "fixed",
  inset: "0",
  pointerEvents: "none",
  zIndex: String(OVERLAY_Z_INDEX),
};

/**
 * DOM 依存を注入するための factory。test で document / window を
 * 触れない環境（node runner）でも renderer を駆動できるようにする
 * seam。production は default factory が `document` / `window` を直接
 * 参照する。詳細は `docs/decisions/effect-rendering-primitives.md`。
 */
export interface RendererDomFactories {
  /** canvas element を生成する。default は document.createElement。 */
  readonly createCanvas: () => HTMLCanvasElement;
  /** div element を生成する。default は document.createElement。 */
  readonly createDiv: () => HTMLDivElement;
  /** HiDPI 解像度の基準 window 幅を返す。 */
  readonly getWindowWidth: () => number;
  /** HiDPI 解像度の基準 window 高さを返す。 */
  readonly getWindowHeight: () => number;
  /** 実 pixel 密度。 */
  readonly getDevicePixelRatio: () => number;
  /** canvasMount を省略した時の default mount element。default は document.body。 */
  readonly getDefaultCanvasMount: () => HTMLElement;
}

interface CameraState {
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly fov: number;
}

export interface RendererCameraController {
  readonly claim?: () => Disposable;
  readonly getState: () => CameraState;
  readonly applyState: (state: CameraState, lookAt?: Vec3) => void;
}

export interface RendererDeps {
  /**
   * addShakeFilter が transform を書き込む対象。production では
   * document.body（body の transform は fixed 子孫の containing block を
   * 作るため、terminal + canvas が同時にシフトする）。test では stub。
   */
  readonly shakeTarget: HTMLElement;
  /**
   * drawOnCanvas が生成した canvas を append する element。
   * production では document.body。省略時は document.body を使う。
   */
  readonly canvasMount?: HTMLElement;
  /** 乱数源。default Math.random。 */
  readonly random?: () => number;
  /**
   * DOM factory の注入口。production では undefined（default は
   * document / window）。test から全要素を差し替えるための seam。
   */
  readonly dom?: RendererDomFactories;
  /**
   * xterm.js の visible cells を抽出する関数。production では
   * TerminalView が提供する。未設定なら queryTerminalCells() は null を返す。
   */
  readonly terminalCellExtractor?: () => TerminalCellData | null;
  /** camera-move effect 用。未指定なら addCameraMove は no-op handle を返す。 */
  readonly camera?: RendererCameraController;
}

/** production default の DOM factory。globalThis.document / window を直接使う。 */
const defaultDomFactories = (): RendererDomFactories => ({
  createCanvas: () => document.createElement("canvas"),
  createDiv: () => document.createElement("div"),
  getWindowWidth: () => window.innerWidth,
  getWindowHeight: () => window.innerHeight,
  getDevicePixelRatio: () => window.devicePixelRatio,
  getDefaultCanvasMount: () => document.body,
});

export class Renderer implements RendererAPI {
  private readonly shakeTarget: HTMLElement;
  private readonly random: () => number;
  private readonly dom: RendererDomFactories;
  private readonly canvasMountOverride: HTMLElement | undefined;
  private readonly terminalCellExtractor: (() => TerminalCellData | null) | undefined;
  private readonly camera: RendererCameraController | undefined;

  /** 現在適用中の CSS filter 値の集合。space-separated で join して style.filter に書く。 */
  private readonly cssFilters = new Set<string>();

  constructor(deps: RendererDeps) {
    this.shakeTarget = deps.shakeTarget;
    this.random = deps.random ?? Math.random;
    this.dom = deps.dom ?? defaultDomFactories();
    this.canvasMountOverride = deps.canvasMount;
    this.terminalCellExtractor = deps.terminalCellExtractor;
    this.camera = deps.camera;
  }

  /** canvasMount の解決。指定されていなければ factory の default を返す。 */
  private resolveCanvasMount(): HTMLElement {
    return this.canvasMountOverride ?? this.dom.getDefaultCanvasMount();
  }

  addShakeFilter(intensity: number): Disposable {
    let disposed = false;
    const start = performance.now();
    const tick = (): void => {
      if (disposed) return;
      const elapsed = performance.now() - start;
      const { dx, dy } = computeShakeOffset(
        elapsed,
        DEFAULT_SHAKE_DECAY_MS,
        intensity,
        this.random,
      );
      this.shakeTarget.style.transform = dx === 0 && dy === 0 ? "" : `translate(${dx}px, ${dy}px)`;
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

  addCssFilter(filter: string): Disposable {
    this.cssFilters.add(filter);
    this.applyCssFilters();
    let disposed = false;
    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        this.cssFilters.delete(filter);
        this.applyCssFilters();
      },
    };
  }

  /** cssFilters の内容を shakeTarget.style.filter に反映する。 */
  private applyCssFilters(): void {
    this.shakeTarget.style.filter = this.cssFilters.size > 0 ? [...this.cssFilters].join(" ") : "";
  }

  addParticles(_config: ParticleConfig): ParticleHandle {
    throw new Error("Renderer.addParticles: not yet implemented");
  }

  addCameraMove(config: CameraMoveConfig): Disposable {
    const camera = this.camera;
    if (!camera) {
      return { dispose: () => {} };
    }

    const durationMs = Math.max(0, config.durationMs);
    const holdMs = Math.max(0, config.holdMs ?? 0);
    const restoreMs = Math.max(0, config.restoreMs ?? durationMs);
    const totalMs = durationMs + holdMs + restoreMs;
    const start = camera.getState();
    const target: CameraState = {
      x: start.x + (config.offset?.x ?? 0),
      y: start.y + (config.offset?.y ?? 0),
      z: start.z + (config.offset?.z ?? 0),
      fov: start.fov + (config.fovOffset ?? 0),
    };
    const claim = camera.claim?.() ?? null;

    let disposed = false;
    let startedAt: number | null = null;

    const finish = (): void => {
      if (disposed) return;
      disposed = true;
      camera.applyState(start, config.lookAt);
      claim?.dispose();
    };

    const tick = (now: number): void => {
      if (disposed) return;
      startedAt ??= now;
      const elapsed = now - startedAt;

      if (elapsed >= totalMs) {
        finish();
        return;
      }

      let frame: CameraState;
      if (elapsed <= durationMs) {
        frame = interpolateCamera(start, target, progress(elapsed, durationMs));
      } else if (elapsed <= durationMs + holdMs) {
        frame = target;
      } else {
        const restoreElapsed = elapsed - durationMs - holdMs;
        frame = interpolateCamera(target, start, progress(restoreElapsed, restoreMs));
      }

      camera.applyState(frame, config.lookAt);
      requestAnimationFrame(tick);
    };

    requestAnimationFrame(tick);

    return { dispose: finish };
  }

  /**
   * 画面全面 overlay の canvas を生成し、2D context を 1 回だけ
   * draw callback に渡す。runtime 側で毎フレーム再呼出しはしない
   * （pack は closure で ctx を保持し自前 RAF loop を回す想定）。
   * Disposable.dispose で canvas を DOM から remove する。2 回以上
   * 呼ばれても安全な冪等実装。
   */
  drawOnCanvas(draw: (ctx: CanvasRenderingContext2D) => void): Disposable {
    const canvas = this.dom.createCanvas();

    // overlay style を一括適用。CSSStyleDeclaration は indexed accessor を
    // 持ち、camelCase key で書ける（kebab は runtime で変換される）。
    Object.assign(canvas.style, CANVAS_OVERLAY_STYLES);

    // HiDPI: backing store は 実 pixel で確保し、ctx.scale(dpr, dpr)
    // で論理座標を window 単位に揃える。
    const dpr = this.dom.getDevicePixelRatio();
    canvas.width = this.dom.getWindowWidth() * dpr;
    canvas.height = this.dom.getWindowHeight() * dpr;

    const mount = this.resolveCanvasMount();
    mount.appendChild(canvas);

    let disposed = false;
    const disposable: Disposable = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        canvas.remove();
      },
    };

    const ctx = canvas.getContext("2d");
    if (ctx === null) {
      // getContext が null を返す環境（test / headless 等）では
      // draw を呼ばず、cleanup だけ担保する。
      return disposable;
    }

    ctx.scale(dpr, dpr);
    draw(ctx);

    return disposable;
  }

  /**
   * 画面全面 overlay の WebGL2 canvas を生成し、`webgl2` context を 1 回だけ
   * draw callback に渡す（GPU シェーダー effect 用）。drawOnCanvas と同じ
   * overlay 原則（全画面 fixed / pointer 透過 / z-index 9999 / HiDPI backing
   * store）に従う。
   *
   * drawOnCanvas が ctx.scale(dpr,dpr) で論理座標へ正規化するのに対し、
   * WebGL では viewport を backing store の実 pixel に合わせるだけ——pack は
   * `gl.drawingBufferWidth / Height` を画面寸法として clip 変換すればよい
   * （dpr が backing store に畳み込まれるので point size も自動で物理 size に
   * スケールする）。
   *
   * GL resource の解放は pack 側の責務。ここは canvas の DOM 着脱だけを
   * 冪等に担保する。webgl2 が取れない環境では draw を呼ばず cleanup のみ。
   */
  drawOnGLCanvas(draw: (gl: WebGL2RenderingContext) => void): Disposable {
    const canvas = this.dom.createCanvas();

    Object.assign(canvas.style, CANVAS_OVERLAY_STYLES);

    const dpr = this.dom.getDevicePixelRatio();
    canvas.width = this.dom.getWindowWidth() * dpr;
    canvas.height = this.dom.getWindowHeight() * dpr;

    const mount = this.resolveCanvasMount();
    mount.appendChild(canvas);

    let disposed = false;
    const disposable: Disposable = {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        canvas.remove();
      },
    };

    // premultipliedAlpha: pack は premultiplied color を出力し blendFunc(ONE,ONE)
    // で加算合成する前提。alpha も蓄積されるので overlay が page 上で正しく
    // 合成される（mix-blend-mode に依存しない）。
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: true,
      depth: false,
      stencil: false,
    });
    if (gl === null) {
      // webgl2 が使えない環境（test / 古い webview 等）では draw を呼ばず、
      // cleanup だけ担保する。
      return disposable;
    }

    gl.viewport(0, 0, canvas.width, canvas.height);
    draw(gl);

    return disposable;
  }

  /**
   * 画面全面 overlay の div を生成し、setup callback を 1 回だけ呼ぶ。
   * pack は container 内で自由に DOM 操作可能。
   * Disposable.dispose で div を DOM から remove する。冪等実装。
   */
  addDomLayer(setup: (container: HTMLDivElement) => void): Disposable {
    const div = this.dom.createDiv();

    // overlay style を一括適用。drawOnCanvas と同じ原則。
    Object.assign(div.style, DOM_OVERLAY_STYLES);

    const mount = this.resolveCanvasMount();
    mount.appendChild(div);

    let disposed = false;

    setup(div);

    return {
      dispose: () => {
        if (disposed) return;
        disposed = true;
        div.remove();
      },
    };
  }

  /**
   * xterm.js の visible cells を読み取る。TextPhysics 等の effect が
   * ターミナルの文字を overlay 上に複製して物理演算を適用するために使う。
   * terminalCellExtractor が未設定なら null を返す。
   */
  queryTerminalCells(): TerminalCellData | null {
    return this.terminalCellExtractor?.() ?? null;
  }
}

function progress(elapsedMs: number, durationMs: number): number {
  if (durationMs <= 0) return 1;
  return easeOutCubic(Math.max(0, Math.min(1, elapsedMs / durationMs)));
}

const easeOutCubic = (t: number): number => 1 - (1 - t) ** 3;

function interpolateCamera(from: CameraState, to: CameraState, t: number): CameraState {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    z: from.z + (to.z - from.z) * t,
    fov: from.fov + (to.fov - from.fov) * t,
  };
}
