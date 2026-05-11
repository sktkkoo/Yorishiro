import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { createElement } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Body } from "../../core/body";
import { registerOrphanMorphs } from "../../core/body/register-orphan-morphs";
import { applyVrmRestPose } from "../../core/body/vrm-rest-pose";
import type { SubsystemLog } from "../../core/dev-log";
import { TweenManager } from "../../core/tween/tween-manager";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { type ClaimState, getClaimState } from "../ui-claim-state";
import { getVrmCache } from "../vrm-cache";
import { CameraModulationRegistry } from "./camera-modulation";
import { R3fHost } from "./r3f-host";
import { R3fRuntimeRoot } from "./r3f-runtime-root";
import type { ThreeRuntime } from "./types";

/**
 * ThreeRuntime implementation. See types.ts for the contract.
 *
 * Key design choices (internal design-record: 2026-04-17-three-runtime-singleton.md):
 *   - canvas / WebGLRenderer / Scene / Camera / RAF loop は factory 内で 1 回だけ構築。
 *     webview lifetime 全体で不変。React の mount lifecycle と完全分離。
 *   - canvas は document.body 直下の div (.three-singleton-container) に append、
 *     React placeholder の rect に ResizeObserver で追従させる。
 *   - VRM load は loadToken で race 回避。連続 setVrmUrl で古い load は破棄。
 *   - bodyListener は late registration：register 時に currentBody があれば即 call。
 *   - RAF loop は 1 本だけ、factory 起動時に永続 start。detach 中も描画継続（WebGL 側で cheap）。
 */
class ThreeRuntimeImpl implements ThreeRuntime {
  private readonly scene: THREE.Scene;
  private readonly camera: THREE.PerspectiveCamera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly canvas: HTMLCanvasElement;
  private readonly canvasContainer: HTMLDivElement;
  private readonly clock: THREE.Clock;
  private readonly loader: GLTFLoader;
  private readonly claimState: ClaimState;
  private readonly r3fHost: R3fHost;

  private readonly bodyListenerRef: {
    current: ((body: Body | null) => void) | null;
  } = { current: null };
  private readonly devLogRef: { current: SubsystemLog | null } = { current: null };
  private readonly headWorldPos = new THREE.Vector3();
  private readonly headScreenPos = new THREE.Vector3();

  private currentUrl: string | null = null;
  private currentVrm: VRM | null = null;
  private currentBody: Body | null = null;
  private trackHead: THREE.Object3D | null = null;
  private loadToken = 0;
  private readonly tweenManager = new TweenManager();
  private readonly cameraBase = { x: 0, y: 1.35, z: 1.1 };
  private readonly cameraModulation = new CameraModulationRegistry();
  private readonly baseFov: number;
  private currentPlaceholder: HTMLElement | null = null;
  private lastRendererW = 0;
  private lastRendererH = 0;
  private cameraTrackingEnabled = true;
  private renderPaused = false;

  constructor() {
    this.claimState = getClaimState();

    // ── Canvas container（attachTo で placeholder の子に移動する）─────
    this.canvasContainer = document.createElement("div");
    this.canvasContainer.className = "three-singleton-container";
    this.canvasContainer.style.position = "absolute";
    this.canvasContainer.style.inset = "0";
    this.canvasContainer.style.visibility = "hidden";
    this.canvasContainer.style.pointerEvents = "none";
    this.canvasContainer.style.zIndex = "0";

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvasContainer.appendChild(this.canvas);

    // ── Scene / Camera ─────────────────────────────────────────────
    // Lighting は scene pack が専有する。ThreeRuntime は light を持たない。
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    this.camera.position.set(0, 1.35, 1.1);
    this.camera.lookAt(0, 1.35, 0);
    this.baseFov = this.camera.fov;

    // ── Renderer ──────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    // ── R3F host（<Canvas> は使わず既存 renderer/scene/camera を共有）────
    this.r3fHost = new R3fHost({
      canvas: this.canvas,
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
    });
    this.initializeR3fHost();

    // ── Clock + loader ────────────────────────────────────────────
    this.clock = new THREE.Clock();
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));

    // ── RAF loop 開始（webview-lifetime、1 本だけ）──────────────────
    this.startRenderLoop();
  }

  attachTo(container: HTMLElement): void {
    this.currentPlaceholder = container;
    container.style.position = "relative";
    container.appendChild(this.canvasContainer);
    this.canvasContainer.style.visibility = "visible";
  }

  detachContainer(): void {
    this.currentPlaceholder = null;
    this.canvasContainer.style.visibility = "hidden";
    this.canvasContainer.remove();
  }

  setShakeOffset(dx: number, dy: number): void {
    this.canvasContainer.style.transform =
      dx === 0 && dy === 0 ? "" : `translate(${dx}px, ${dy}px)`;
  }

  setVrmUrl(url: string | null): void {
    if (url === this.currentUrl) return;
    this.currentUrl = url;
    this.loadToken++;
    const myToken = this.loadToken;

    this.disposeCurrentVrm();

    if (url === null) {
      return;
    }

    void (async () => {
      try {
        const buffer = await getVrmCache().getBytes(url);
        if (myToken !== this.loadToken) return;

        await new Promise<void>((resolve, reject) => {
          this.loader.parse(
            buffer,
            "",
            (gltf) => {
              if (myToken !== this.loadToken) {
                resolve();
                return;
              }
              const vrm = gltf.userData.vrm as VRM;
              if (!vrm) {
                console.warn("[three-runtime] GLTF did not contain VRM payload:", url);
                resolve();
                return;
              }

              VRMUtils.rotateVRM0(vrm);
              applyVrmRestPose(vrm);
              vrm.humanoid?.update();

              // BlendShapeMaster に wired されていない orphan morph (Hana Tool /
              // Perfect Sync 系) を synthetic VRMExpression として登録し、
              // expressionManager.setValue(<morph名>, w) で駆動可能にする。
              // Body 構築前に必ず終わらせる（slot mixer が name を resolve する前提のため）。
              const orphans = registerOrphanMorphs(vrm);
              if (orphans.registered.length > 0) {
                console.debug(
                  `[three-runtime] registered ${orphans.registered.length} orphan morphs as synthetic expressions`,
                );
              }

              this.scene.add(vrm.scene);
              this.currentVrm = vrm;
              this.currentBody = new Body(
                vrm,
                this.devLogRef.current ?? undefined,
                this.claimState,
              );

              vrm.scene.updateWorldMatrix(true, true);
              vrm.update(0);

              const headBone = vrm.humanoid?.getNormalizedBoneNode("head");
              this.trackHead = headBone ?? null;

              const headPos = new THREE.Vector3();
              if (headBone) headBone.getWorldPosition(headPos);
              else headPos.set(0, 1.6, 0);

              const targetY = headPos.y - 0.05;
              this.cameraBase.x = 0;
              this.cameraBase.y = targetY;
              this.cameraBase.z = 1.1;
              this.camera.position.set(0, targetY, 1.1);
              this.camera.lookAt(0, targetY, 0);

              this.bodyListenerRef.current?.(this.currentBody);
              resolve();
            },
            (err) => reject(err),
          );
        });
      } catch (err) {
        if (myToken !== this.loadToken) return;
        console.error("[three-runtime] VRM load failed:", err);
      }
    })();
  }

  setBodyListener(listener: ((body: Body | null) => void) | null): void {
    this.bodyListenerRef.current = listener;
    if (listener !== null && this.currentBody !== null) {
      listener(this.currentBody);
    }
  }

  setDevLog(devLog: SubsystemLog | null): void {
    this.devLogRef.current = devLog;
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getRenderer(): THREE.WebGLRenderer {
    return this.renderer;
  }

  getVrm(): VRM | null {
    return this.currentVrm;
  }

  getBody(): Body | null {
    return this.currentBody;
  }

  getTweenManager(): TweenManager {
    return this.tweenManager;
  }

  setCameraTracking(enabled: boolean): void {
    if (enabled && !this.cameraTrackingEnabled) {
      this.cameraBase.x = this.camera.position.x;
      this.cameraBase.y = this.camera.position.y;
      this.cameraBase.z = this.camera.position.z;
    }
    this.cameraTrackingEnabled = enabled;
  }

  getCameraTracking(): boolean {
    return this.cameraTrackingEnabled;
  }

  /**
   * Render loop の pause / resume。
   * paused のとき RAF は継続するが、tweenManager.tick / body.update / renderer.render を skip する。
   * sidebar が display:none の間（presence closed）に CPU/GPU を休ませる用途。
   */
  setRenderPaused(paused: boolean): void {
    this.renderPaused = paused;
  }

  isRenderPaused(): boolean {
    return this.renderPaused;
  }

  getCameraModulation(): CameraModulationRegistry {
    return this.cameraModulation;
  }

  setCameraBase(x: number, y: number, z: number): void {
    this.cameraBase.x = x;
    this.cameraBase.y = y;
    this.cameraBase.z = z;
  }

  isCameraModulationSuspended(): boolean {
    return this.claimState.isClaimed("camera") || !this.cameraModulation.enabled;
  }

  // ─── private methods ────────────────────────────────────────────

  private startRenderLoop(): void {
    const tick = () => {
      requestAnimationFrame(tick);

      // paused 時は早期 return。clock.getDelta() だけは呼んで oldTime を進めることで
      // resume 直後の最初の tick で大きな delta jump が起きるのを防ぐ。
      if (this.renderPaused) {
        this.clock.getDelta();
        return;
      }

      const now = performance.now();
      const delta = this.clock.getDelta();
      const elapsed = this.clock.getElapsedTime();

      this.handleResize();
      this.tweenManager.tick(now);

      if (this.currentBody) {
        this.updateBodyPointerReference();
        this.currentBody.update(delta, elapsed);

        const cameraClaimed = this.claimState.isClaimed("camera");

        // Step 1: Base — VRM head tracking（claim 未取得時のみ）
        if (this.trackHead && this.cameraTrackingEnabled && !cameraClaimed) {
          this.trackHead.getWorldPosition(this.headWorldPos);
          const desiredY = this.headWorldPos.y - 0.05;
          this.cameraBase.y += (desiredY - this.cameraBase.y) * Math.min(1.5 * delta, 1);
        }

        // Step 2: Position 適用（tracking ON かつ claim 未取得の場合のみ）
        // tracking OFF 時は外部（UI pack / leva）が直接 camera.position を制御する
        if (!cameraClaimed && this.cameraTrackingEnabled) {
          if (this.cameraModulation.enabled) {
            const offset = this.cameraModulation.evaluatePosition(elapsed, delta);
            this.camera.position.x = this.cameraBase.x + offset.x;
            this.camera.position.y = this.cameraBase.y + offset.y;
            this.camera.position.z = this.cameraBase.z + offset.z;

            const fovOffset = this.cameraModulation.evaluateFov(elapsed, delta);
            if (fovOffset !== 0) {
              this.camera.fov = this.baseFov + fovOffset;
              this.camera.updateProjectionMatrix();
            }
          } else {
            this.camera.position.x = this.cameraBase.x;
            this.camera.position.y = this.cameraBase.y;
            this.camera.position.z = this.cameraBase.z;
          }
        }

        // Step 3: lookAt — modulation 適用後の position から target を見る
        if (this.cameraTrackingEnabled && !cameraClaimed) {
          this.camera.lookAt(0, this.camera.position.y, 0);
        }
      }

      if (!this.r3fHost.advance(now)) {
        this.renderer.render(this.scene, this.camera);
      }
    };
    requestAnimationFrame(tick);
  }

  private initializeR3fHost(): void {
    void this.r3fHost
      .initialize()
      .then(() => {
        this.r3fHost.render(createElement(R3fRuntimeRoot));
        if (this.lastRendererW > 0 && this.lastRendererH > 0) {
          this.r3fHost.setSize(this.lastRendererW, this.lastRendererH);
        }
      })
      .catch((err) => {
        console.error("[three-runtime] R3F host initialization failed:", err);
      });
  }

  private handleResize(): void {
    if (!this.currentPlaceholder) return;
    const w = this.currentPlaceholder.clientWidth;
    const h = this.currentPlaceholder.clientHeight;
    if (w === 0 || h === 0) return;

    if (w !== this.lastRendererW || h !== this.lastRendererH) {
      this.lastRendererW = w;
      this.lastRendererH = h;
      if (this.r3fHost.isReady()) {
        this.r3fHost.setSize(w, h);
      } else {
        this.renderer.setSize(w, h);
        this.camera.aspect = w / h;
        this.camera.updateProjectionMatrix();
      }
    }
  }

  private updateBodyPointerReference(): void {
    if (!this.currentBody || !this.trackHead || !this.currentPlaceholder) return;

    this.trackHead.getWorldPosition(this.headWorldPos);
    this.headScreenPos.copy(this.headWorldPos).project(this.camera);
    const rect = this.currentPlaceholder.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    const headClientX = rect.left + ((this.headScreenPos.x + 1) / 2) * rect.width;
    const headClientY = rect.top + ((1 - this.headScreenPos.y) / 2) * rect.height;
    this.currentBody.setHeadClientReference(headClientX, headClientY, rect.width, rect.height);
  }

  private disposeCurrentVrm(): void {
    if (this.currentBody) {
      this.currentBody.dispose();
      this.currentBody = null;
      this.bodyListenerRef.current?.(null);
    }
    if (this.currentVrm) {
      this.scene.remove(this.currentVrm.scene);
      this.currentVrm.scene.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry?.dispose();
          if (Array.isArray(obj.material)) {
            for (const mat of obj.material) mat.dispose();
          } else {
            obj.material?.dispose();
          }
        }
      });
      this.currentVrm = null;
      this.trackHead = null;
    }
  }
}

export function getThreeRuntime(): ThreeRuntime {
  return getOrInit(KEYS.THREE_RUNTIME, () => new ThreeRuntimeImpl());
}

// Self-accept: three-runtime.ts を編集しても upstream (vrm-viewer.tsx) を
// invalidate しない。ただし class 定義が変わると hot.data 内の既存 instance は
// 古いクラスのままなので、構造的な変更は tauri dev 再起動推奨。
if (import.meta.hot) {
  import.meta.hot.accept();
}
