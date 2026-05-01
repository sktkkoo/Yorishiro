import {
  createRoot,
  type ReconcilerRoot,
  type RootState,
  type RootStore,
} from "@react-three/fiber";
import type { ReactNode } from "react";
import type * as THREE from "three";

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
      .then(() => undefined);

    return this.configurePromise;
  }

  render(element: ReactNode): void {
    if (this.disposed) return;
    this.store = this.root.render(element);
    this.state = this.store.getState();
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
