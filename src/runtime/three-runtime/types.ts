import type { VRM } from "@pixiv/three-vrm";
import type * as THREE from "three";
import type { Body } from "../../core/body";
import type { SubsystemLog } from "../../core/dev-log";
import type { TweenManager } from "../../core/tween/tween-manager";
import type { CameraModulationRegistry } from "./camera-modulation";

/**
 * ThreeRuntime の public interface。vrm-viewer.tsx が参照するのはこの型だけ。
 *
 * 寿命: webview lifetime（= hot-data 経由で HMR 越しに同一 instance）。
 * 責務:
 *   - WebGLRenderer / Scene / PerspectiveCamera / Lights / THREE.Clock の保持
 *   - canvas DOM の保持（document.body 直下）
 *   - RAF loop の単一管理（二重化しない）
 *   - 現 VRM / Body の lifecycle 管理（URL 変化で dispose + reload）
 *   - bodyListener / devLog の ref 反映
 *
 * 非責務:
 *   - Body 内部 subsystem の refactor（Phase 3 ProceduralModule で扱う）
 *   - VRM blob cache（別 spec、Phase 2.5 相当）
 *   - camera / lights / scene objects の UGC 差し替え API（Phase 2 scope 外、将来拡張）
 *
 * Internal design-record: 2026-04-17-three-runtime-singleton.md Section 3.
 */
export interface ThreeRuntime {
  /** React placeholder を canvas の配置先として登録。複数回呼ばれても冪等。 */
  attachTo(container: HTMLElement): void;
  /** React unmount 時の解除。canvas は document.body に残り visibility: hidden になる。 */
  detachContainer(): void;
  /** VRM URL を更新。同 URL なら no-op、差分あれば旧 VRM/Body を dispose し新 VRM を非同期 load。 */
  setVrmUrl(url: string | null): void;
  /** Body 生成/消滅の listener。登録時に現 Body があれば即座に call する（late registration）。 */
  setBodyListener(listener: ((body: Body | null) => void) | null): void;
  /** dev-log を反映。null で暗黙 disable。次の VRM load 時から Body に渡される。 */
  setDevLog(devLog: SubsystemLog | null): void;
  /**
   * Shake 用の translate offset を canvasContainer に適用する。
   * (0, 0) で解除。position: fixed の top/left と共存し、transform は独立に効く。
   * 実装 note: canvas は placeholder の子ではないので、placeholder 側に transform
   * しても動かない。canvasContainer 自身に当てる必要がある。
   */
  setShakeOffset(dx: number, dy: number): void;
  /** UI pack 等が直接操作するための getter。 */
  getCamera(): THREE.PerspectiveCamera;
  getScene(): THREE.Scene;
  getRenderer(): THREE.WebGLRenderer;
  /** VRM 未 load なら null。load 後に非 null。 */
  getVrm(): VRM | null;
  /** Body 未生成なら null。VRM load 完了後に非 null。 */
  getBody(): Body | null;
  /** TweenManager instance。per-frame 補間の backing store。 */
  getTweenManager(): TweenManager;
  /** カメラ自動追従（head tracking）の有効/無効。app-level の設定で、claim とは独立。 */
  setCameraTracking(enabled: boolean): void;
  getCameraTracking(): boolean;

  /**
   * Render loop の pause / resume。paused 時は RAF の中身を skip する
   * （tweenManager.tick / body.update / renderer.render はすべて休む）。
   * presence intensity が aura-only / closed のとき CPU/GPU を休ませる用途。
   */
  setRenderPaused(paused: boolean): void;
  isRenderPaused(): boolean;

  /**
   * R3F-component scene pack が独自 lighting を持つ場合に ThreeRuntime の
   * built-in lights (AmbientLight + DirectionalLight) を disable / enable する.
   */
  setDefaultLightsEnabled(enabled: boolean): void;

  /** Scene pack が camera に continuous modulation を登録するための registry。 */
  getCameraModulation(): CameraModulationRegistry;

  /** cameraBase（modulation 前の pure position）を外部から設定する。MCP instant set 用。 */
  setCameraBase(x: number, y: number, z: number): void;

  /** camera modulation が suspend 中か（claim 中 or enabled=false）。 */
  isCameraModulationSuspended(): boolean;
}
