import {
  createRoot,
  extend,
  type ReconcilerRoot,
  type RootState,
  type RootStore,
} from "@react-three/fiber";
import type { ReactNode } from "react";
import * as THREE from "three";

// `<Canvas>` は内部で `extend(THREE)` を呼び全 THREE.* 要素を JSX として使えるように
// するが、custom root は明示呼び出しが必要。ここで全部登録しておくことで scene 側が
// どの primitive を使うかに依存しない（個別 register 漏れによる「JSX 要素は書けるが
// 何も描画されない」事故を防ぐ）。
//
// 型キャスト: extend は constructor の Record を期待するが、THREE namespace には
// non-constructor exports（UniformsUtils, MathUtils 等）も含まれる。ランタイムでは
// constructor のみが使われるため安全。R3F コミュニティの慣用 workaround。
extend(THREE as unknown as Parameters<typeof extend>[0]);

interface R3fHostDeps {
  readonly canvas: HTMLCanvasElement;
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly getDevicePixelRatio?: () => number;
}

/**
 * R3F custom-root adapter for ThreeRuntime.
 *
 * This deliberately does not use <Canvas>. ThreeRuntime remains the owner of
 * the canvas DOM, renderer, resize policy, and RAF loop; R3F only reconciles
 * Three.js objects into the existing scene and is advanced manually.
 */
export class R3fHost {
  private readonly root: ReconcilerRoot<HTMLCanvasElement>;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly getDevicePixelRatio: () => number;

  private configurePromise: Promise<void> | null = null;
  private store: RootStore | null = null;
  private state: RootState | null = null;
  private configured = false;
  private disposed = false;

  constructor({
    canvas,
    renderer,
    scene,
    camera,
    getDevicePixelRatio = () => window.devicePixelRatio,
  }: R3fHostDeps) {
    this.root = createRoot(canvas);
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.getDevicePixelRatio = getDevicePixelRatio;
  }

  initialize(): Promise<void> {
    if (this.configurePromise) return this.configurePromise;

    this.configurePromise = this.root
      .configure({
        gl: this.renderer,
        scene: this.scene,
        camera: this.camera,
        frameloop: "never",
        dpr: Math.min(this.getDevicePixelRatio(), 2),
        flat: true,
        onCreated: (state) => {
          this.state = state;
        },
      })
      .then(() => {
        this.configured = true;
      });

    return this.configurePromise;
  }

  render(element: ReactNode): boolean {
    if (this.disposed || !this.configured) return false;
    this.store = this.root.render(element);
    this.state = this.store.getState();
    return true;
  }

  advance(timestampMs: number): boolean {
    const state = this.getState();
    if (!state) return false;
    state.advance(timestampMs, true);
    return true;
  }

  setSize(width: number, height: number): void {
    const state = this.getState();
    if (!state) return;
    state.setSize(width, height);
  }

  isReady(): boolean {
    return this.getState() !== null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.root.unmount();
    this.store = null;
    this.state = null;
  }

  private getState(): RootState | null {
    return this.state ?? this.store?.getState() ?? null;
  }
}
