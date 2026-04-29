import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Body } from "../../core/body";
import type { SubsystemLog } from "../../core/dev-log";
import { TweenManager } from "../../core/tween/tween-manager";
import { getOrInit } from "../hot-data";
import { KEYS } from "../module-registry/keys";
import { type ClaimState, getClaimState } from "../ui-claim-state";
import { getVrmCache } from "../vrm-cache";
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
  private currentPlaceholder: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private needsResize = true;
  private cameraTrackingEnabled = true;

  constructor() {
    this.claimState = getClaimState();

    // ── Canvas container (document.body 直下、singleton-owned) ─────
    this.canvasContainer = document.createElement("div");
    this.canvasContainer.className = "three-singleton-container";
    this.canvasContainer.style.position = "fixed";
    this.canvasContainer.style.visibility = "hidden";
    this.canvasContainer.style.pointerEvents = "none";
    this.canvasContainer.style.zIndex = "0";
    document.body.appendChild(this.canvasContainer);

    this.canvas = document.createElement("canvas");
    this.canvas.style.display = "block";
    this.canvas.style.width = "100%";
    this.canvas.style.height = "100%";
    this.canvasContainer.appendChild(this.canvas);

    // ── Scene / Camera / Lights ───────────────────────────────────
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    this.camera.position.set(0, 1.35, 1.1);
    this.camera.lookAt(0, 1.35, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(1, 2, 2);
    this.scene.add(dirLight);

    // ── Renderer ──────────────────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);

    // ── Clock + loader ────────────────────────────────────────────
    this.clock = new THREE.Clock();
    this.loader = new GLTFLoader();
    this.loader.register((parser) => new VRMLoaderPlugin(parser));

    // ── RAF loop 開始（webview-lifetime、1 本だけ）──────────────────
    this.startRenderLoop();
  }

  attachTo(container: HTMLElement): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.currentPlaceholder = container;

    const syncRect = () => {
      const rect = container.getBoundingClientRect();
      this.canvasContainer.style.top = `${rect.top}px`;
      this.canvasContainer.style.left = `${rect.left}px`;
      this.canvasContainer.style.width = `${rect.width}px`;
      this.canvasContainer.style.height = `${rect.height}px`;
      this.canvasContainer.style.visibility = "visible";
      this.needsResize = true;
    };

    syncRect();

    this.resizeObserver = new ResizeObserver(syncRect);
    this.resizeObserver.observe(container);
  }

  detachContainer(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.currentPlaceholder = null;
    this.canvasContainer.style.visibility = "hidden";
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

              vrm.scene.rotation.y = Math.PI;
              this.setupRestPose(vrm);
              vrm.humanoid?.update();

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
    this.cameraTrackingEnabled = enabled;
  }

  getCameraTracking(): boolean {
    return this.cameraTrackingEnabled;
  }

  // ─── private methods ────────────────────────────────────────────

  private startRenderLoop(): void {
    const tick = () => {
      requestAnimationFrame(tick);

      const delta = this.clock.getDelta();
      const elapsed = this.clock.getElapsedTime();

      this.handleResize();
      this.tweenManager.tick(performance.now());

      if (this.currentBody) {
        this.updateBodyPointerReference();
        this.currentBody.update(delta, elapsed);

        if (this.trackHead && this.cameraTrackingEnabled && !this.claimState.isClaimed("camera")) {
          this.trackHead.getWorldPosition(this.headWorldPos);
          const desiredY = this.headWorldPos.y - 0.05;
          this.camera.position.y += (desiredY - this.camera.position.y) * Math.min(1.5 * delta, 1);
          this.camera.lookAt(0, this.camera.position.y, 0);
        }
      }

      this.renderer.render(this.scene, this.camera);
    };
    requestAnimationFrame(tick);
  }

  private handleResize(): void {
    if (!this.needsResize || !this.currentPlaceholder) return;
    this.needsResize = false;
    const w = this.currentPlaceholder.clientWidth;
    const h = this.currentPlaceholder.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
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

  /**
   * Lower arms from T-pose to a natural rest position + relaxed finger curl.
   * Lifted from the legacy vrm-viewer.tsx module-level function.
   */
  private setupRestPose(vrm: VRM): void {
    const humanoid = vrm.humanoid;
    if (!humanoid) return;

    const set = (name: VRMHumanBoneName, axis: "x" | "y" | "z", rad: number) => {
      const bone = humanoid.getNormalizedBoneNode(name);
      if (bone) bone.rotation[axis] = rad;
    };

    // Upper arms down from T-pose
    set("rightUpperArm", "z", -1.35);
    set("leftUpperArm", "z", 1.35);
    set("rightUpperArm", "x", 0.1);
    set("leftUpperArm", "x", 0.1);

    // Lower arms slightly bent
    set("rightLowerArm", "z", -0.2);
    set("leftLowerArm", "z", 0.2);

    // Straighten wrists — upper arm rotation causes slight upward bend
    set("leftHand", "z", 0.2);
    set("rightHand", "z", -0.2);

    // Relaxed finger curl — proximal > intermediate > distal で自然なカーブ
    const fingerCurl: ReadonlyArray<[string, number]> = [
      ["IndexProximal", 0.25],
      ["IndexIntermediate", 0.35],
      ["IndexDistal", 0.2],
      ["MiddleProximal", 0.3],
      ["MiddleIntermediate", 0.4],
      ["MiddleDistal", 0.25],
      ["RingProximal", 0.35],
      ["RingIntermediate", 0.45],
      ["RingDistal", 0.25],
      ["LittleProximal", 0.4],
      ["LittleIntermediate", 0.5],
      ["LittleDistal", 0.3],
    ];
    for (const [suffix, angle] of fingerCurl) {
      set(`left${suffix}` as VRMHumanBoneName, "x", angle);
      set(`right${suffix}` as VRMHumanBoneName, "x", angle);
    }

    // 親指 — 軸が異なる、軽く内側に畳む
    for (const side of ["left", "right"] as const) {
      const sign = side === "left" ? 1 : -1;
      set(`${side}ThumbMetacarpal` as VRMHumanBoneName, "x", 0.2);
      set(`${side}ThumbMetacarpal` as VRMHumanBoneName, "z", sign * 0.3);
      set(`${side}ThumbProximal` as VRMHumanBoneName, "x", 0.15);
      set(`${side}ThumbDistal` as VRMHumanBoneName, "x", 0.1);
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
