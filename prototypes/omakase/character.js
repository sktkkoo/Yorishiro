/**
 * Local-only VRM scene for the HTML UX prototype.
 * build-character.mjs embeds the existing licensed local assets in an ignored
 * bundle so index.html also works via file:// without fetch or CDN dependencies.
 */

import { VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import idleBase64 from "../../public/animations/Idle.vrma";
import modelBase64 from "../../public/models/Yori.vrm";
import { applyVrmRestPose } from "../../src/core/body/vrm-rest-pose.ts";
import { defaultCameraForCharacter } from "../../src/runtime/view-mode-framing.ts";

const validStates = new Set([
  "idle",
  "listening",
  "thinking",
  "speaking",
  "working",
  "review",
  "done",
  "paused",
  "failed",
]);
const stateLabels = {
  idle: "よりが待っています",
  listening: "よりが話を聞いています",
  thinking: "よりが返事を考えています",
  speaking: "よりが話しています",
  working: "よりが資料を確認しています",
  review: "よりが確認を待っています",
  done: "よりが作業を終えました",
  paused: "よりが作業を休止しています",
  failed: "よりが作業を止めて確認しています",
};
// Conversation attention stays close to the user. Thinking briefly lowers the
// gaze; speaking returns it with a slight expression change. There is no audio
// analyser in this demo, so speaking never invents lip-sync or phoneme motion.
const attentionPoses = {
  idle: { yaw: 0, pitch: 0, gazeX: 0, gazeDrop: 0, happy: 0.03 },
  listening: { yaw: 0, pitch: -0.025, gazeX: 0, gazeDrop: 0, happy: 0.03 },
  thinking: { yaw: -0.04, pitch: 0.025, gazeX: -0.2, gazeDrop: 0.06, happy: 0.015 },
  speaking: { yaw: 0, pitch: -0.008, gazeX: 0, gazeDrop: 0, happy: 0.07 },
  working: { yaw: 0.13, pitch: 0.055, gazeX: 0.7, gazeDrop: 0.14, happy: 0.03 },
  done: { yaw: 0, pitch: 0, gazeX: 0, gazeDrop: 0, happy: 0.16 },
};
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
let state = "idle";
let stage;
let renderer;
let scene;
let camera;
let vrm;
let mixer;
let head;
let spine;
let gazeTarget;
let lastFrame = 0;
let elapsed = 0;
let frame = 0;
let ready = false;
let disposed = false;
let nodTime = -1;
let yaw = 0;
let pitch = 0;
let happy = 0;
let nextBlink = 3.6;
let blinkTime = -1;
let width = 0;
let height = 0;
let resizeObserver;
const headAnchor = new THREE.Vector3();
const baseHeadQuaternion = new THREE.Quaternion();
const baseSpineQuaternion = new THREE.Quaternion();
const headOffset = new THREE.Quaternion();
const spineOffset = new THREE.Quaternion();
const headAngles = new THREE.Euler();

const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));

async function decodeAsset(base64) {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  const bytes = new Uint8Array(base64.length * 0.75 - padding);
  const chunkSize = 262144;
  let offset = 0;
  for (let start = 0; start < base64.length; start += chunkSize) {
    if (disposed) return null;
    const chunk = atob(base64.slice(start, start + chunkSize));
    for (let i = 0; i < chunk.length; i++) bytes[offset++] = chunk.charCodeAt(i);
    if (start % (chunkSize * 8) === 0) {
      await yieldToPage();
      if (disposed) return null;
    }
  }
  return bytes.buffer;
}

function loading(message) {
  const label = document.getElementById("character-load");
  if (label) label.textContent = message;
}

async function optimizeTextures(root) {
  const textures = new Set();
  root.traverse((object) => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });
  const replacements = new Map();
  for (const texture of textures) {
    if (disposed) break;
    const source = texture.image;
    if (!source || Math.max(source.width || 0, source.height || 0) <= 2048) continue;
    let resized = replacements.get(source);
    if (!resized) {
      const scale = 2048 / Math.max(source.width, source.height);
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(source.width * scale));
      canvas.height = Math.max(1, Math.round(source.height * scale));
      const context = canvas.getContext("2d");
      if (!context) continue;
      context.drawImage(source, 0, 0, canvas.width, canvas.height);
      resized = canvas;
      replacements.set(source, resized);
      await yieldToPage();
      if (disposed) break;
    }
    texture.image = resized;
    texture.needsUpdate = true;
  }
  for (const source of replacements.keys()) source.close?.();
}

function notify(ok, message) {
  window.dispatchEvent(
    new CustomEvent("yorishiro:character-ready", {
      detail: { ok, ...(message ? { message } : {}) },
    }),
  );
}

function resize() {
  if (!renderer || !stage || !camera || disposed) return;
  const bounds = stage.getBoundingClientRect();
  const nextWidth = Math.max(1, Math.round(bounds.width));
  const nextHeight = Math.max(1, Math.round(bounds.height));
  if (width === nextWidth && height === nextHeight) return;
  width = nextWidth;
  height = nextHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  if (ready) draw(0);
}

function updatePose(dt) {
  // Restore overlays before advancing the recording, preventing accumulation
  // on bones that a particular VRMA happens not to animate.
  if (head) head.quaternion.copy(baseHeadQuaternion);
  if (spine) spine.quaternion.copy(baseSpineQuaternion);
  if (!reducedMotion.matches) mixer?.update(dt);
  if (head) baseHeadQuaternion.copy(head.quaternion);
  if (spine) baseSpineQuaternion.copy(spine.quaternion);

  const attention = attentionPoses[state] || attentionPoses.idle;
  const blend = reducedMotion.matches ? 1 : 1 - Math.exp(-dt * 3.2);
  yaw += (attention.yaw - yaw) * blend;
  pitch += (attention.pitch - pitch) * blend;
  happy += (attention.happy - happy) * blend;

  let nod = 0;
  if (nodTime >= 0 && !reducedMotion.matches) {
    nodTime += dt;
    nod = Math.sin(Math.min(1, nodTime / 0.8) * Math.PI) * 0.09;
    if (nodTime >= 0.8) nodTime = -1;
  }
  if (head) {
    headAngles.set(pitch + nod, yaw, 0);
    headOffset.setFromEuler(headAngles);
    head.quaternion.multiply(headOffset);
  }
  if (spine) {
    const breath = reducedMotion.matches ? 0 : Math.sin(elapsed * 1.3) * 0.003;
    spineOffset.setFromEuler(headAngles.set(breath, yaw * 0.22, 0));
    spine.quaternion.multiply(spineOffset);
  }
  if (gazeTarget) {
    gazeTarget.position.x += (attention.gazeX - gazeTarget.position.x) * blend;
    gazeTarget.position.y += (headAnchor.y - attention.gazeDrop - gazeTarget.position.y) * blend;
  }

  let blink = 0;
  if (!reducedMotion.matches) {
    nextBlink -= dt;
    if (nextBlink <= 0 && blinkTime < 0) {
      blinkTime = 0;
      nextBlink = 4.2 + Math.random() * 2.2;
    }
    if (blinkTime >= 0) {
      blinkTime += dt;
      blink = Math.sin(Math.min(1, blinkTime / 0.16) * Math.PI);
      if (blinkTime >= 0.16) blinkTime = -1;
    }
  }
  vrm.expressionManager?.setValue("blink", blink);
  vrm.expressionManager?.setValue("happy", happy);
  vrm.update(dt);
}

function draw(dt) {
  if (!ready || disposed) return;
  elapsed += dt;
  updatePose(dt);
  renderer.render(scene, camera);
}

function animate(now) {
  frame = 0;
  if (!ready || disposed || document.hidden) return;
  const dt = lastFrame ? Math.min((now - lastFrame) / 1000, 1 / 20) : 0;
  lastFrame = now;
  draw(dt);
  if (!reducedMotion.matches) frame = requestAnimationFrame(animate);
}

function requestFrame() {
  if (!ready || disposed || document.hidden || frame) return;
  lastFrame = 0;
  frame = requestAnimationFrame(animate);
}

function onVisibilityChange() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  lastFrame = 0;
  if (!document.hidden) requestFrame();
}

function onMotionPreference() {
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  requestFrame();
}

function setState(nextState) {
  if (disposed || !validStates.has(nextState)) return;
  const previous = state;
  state = nextState;
  if (renderer) renderer.domElement.setAttribute("aria-label", stateLabels[state]);
  if (stage) stage.dataset.characterState = state;
  if (nextState === "done" && previous !== "done") nodTime = 0;
  requestFrame();
}

function acknowledge() {
  if (disposed) return;
  nodTime = 0;
  requestFrame();
}

function releaseModel(root) {
  if (!root) return;
  const textures = new Set();
  root.traverse((object) => {
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value?.isTexture) textures.add(value);
      }
    }
  });
  const images = new Set([...textures].map((texture) => texture.image).filter(Boolean));
  VRMUtils.deepDispose(root);
  // Texture.dispose releases GPU storage, but not decoded ImageBitmap memory.
  for (const image of images) image.close?.();
  for (const texture of textures) texture.image = null;
  root.removeFromParent();
}

function dispose() {
  if (disposed) return;
  disposed = true;
  ready = false;
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  resizeObserver?.disconnect();
  document.removeEventListener("visibilitychange", onVisibilityChange);
  reducedMotion.removeEventListener("change", onMotionPreference);
  mixer?.stopAllAction();
  if (vrm) {
    mixer?.uncacheRoot(vrm.scene);
    releaseModel(vrm.scene);
  }
  scene?.clear();
  renderer?.dispose();
  renderer?.forceContextLoss();
  renderer?.domElement.remove();
  vrm = mixer = scene = renderer = camera = head = spine = gazeTarget = null;
}

// Install synchronously: the surrounding prototype can set a state while the
// embedded 22 MB model is still decoding.
window.yoriCharacter = {
  setState,
  acknowledge,
  dispose,
  get ready() {
    return ready;
  },
  get state() {
    return state;
  },
};

async function init() {
  if (disposed) return;
  stage = document.getElementById("character-stage");
  if (!stage) {
    notify(false, "キャラクターの表示領域がありません");
    return;
  }
  try {
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.25));
    renderer.setClearColor(0x000000, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NoToneMapping;
    const canvas = renderer.domElement;
    canvas.className = "character-canvas";
    canvas.setAttribute("role", "img");
    canvas.setAttribute("aria-label", stateLabels[state]);
    Object.assign(canvas.style, {
      position: "absolute",
      inset: "0",
      width: "100%",
      height: "100%",
      display: "block",
      pointerEvents: "none",
    });
    canvas.addEventListener("webglcontextlost", (event) => {
      if (disposed) return;
      event.preventDefault();
      ready = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      notify(false, "3D表示が中断しました。ページを再読み込みしてください");
    });
    stage.append(canvas);
    stage.dataset.characterState = state;
    scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, 0xb6b0a4, 0.9));
    const key = new THREE.DirectionalLight(0xfff5e6, 1.1);
    key.position.set(-2, 3.5, 4);
    scene.add(key);
    const fill = new THREE.DirectionalLight(0xf4f7ff, 0.3);
    fill.position.set(3, 1.8, 2);
    scene.add(fill);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
    loading("モデルを読み込んでいます");
    const modelData = await decodeAsset(modelBase64);
    if (disposed || !modelData) return;
    const model = await loader.parseAsync(modelData, "");
    if (disposed) {
      releaseModel(model.scene);
      return;
    }
    vrm = model.userData.vrm;
    if (!vrm) throw new Error("VRMモデルを読み込めませんでした");
    loading("表示を準備しています");
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.combineSkeletons(vrm.scene);
    await optimizeTextures(vrm.scene);
    if (disposed) return;
    VRMUtils.rotateVRM0(vrm);
    applyVrmRestPose(vrm);
    vrm.humanoid.update();
    scene.add(vrm.scene);

    // A quiet recording gives the body its own timing. Work states only add a
    // small, meaningful attention change instead of making it pantomime typing.
    try {
      const animationData = await decodeAsset(idleBase64);
      if (disposed || !animationData) return;
      const animation = await loader.parseAsync(animationData, "");
      if (disposed) {
        releaseModel(animation.scene);
        return;
      }
      const source = animation.userData.vrmAnimations?.[0];
      if (source) {
        mixer = new THREE.AnimationMixer(vrm.scene);
        const clip = createVRMAnimationClip(source, vrm);
        if (clip.tracks.some((track) => !track.values.every(Number.isFinite))) {
          throw new Error("Invalid animation values");
        }
        const action = mixer.clipAction(clip);
        action.setLoop(THREE.LoopRepeat, Infinity);
        action.setEffectiveTimeScale(0.65);
        action.play();
        mixer.setTime(Math.min(1.5, clip.duration * 0.25));
      }
    } catch (error) {
      if (disposed) return;
      console.warn("Yorishiro prototype: using the resting pose", error);
      mixer = null;
      applyVrmRestPose(vrm);
    }
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    head = vrm.humanoid.getNormalizedBoneNode("head");
    spine = vrm.humanoid.getNormalizedBoneNode("spine");
    if (head) {
      head.getWorldPosition(headAnchor);
      baseHeadQuaternion.copy(head.quaternion);
    } else headAnchor.set(0, 1.6, 0);
    if (spine) baseSpineQuaternion.copy(spine.quaternion);
    // Use the normal Yorishiro view's framing in its 280px character column.
    const framing = defaultCameraForCharacter(headAnchor);
    camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(framing.x, framing.y, framing.z);
    camera.lookAt(framing.x, framing.y, 0);

    gazeTarget = new THREE.Object3D();
    gazeTarget.position.set(0, headAnchor.y, 2.2);
    scene.add(gazeTarget);
    if (vrm.lookAt) vrm.lookAt.target = gazeTarget;
    resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(stage);
    document.addEventListener("visibilitychange", onVisibilityChange);
    reducedMotion.addEventListener("change", onMotionPreference);
    resize();
    await renderer.compileAsync(scene, camera);
    if (disposed) return;
    await yieldToPage();
    if (disposed) return;
    ready = true;
    draw(0);
    notify(true);
    requestFrame();
  } catch (error) {
    if (disposed) return;
    console.error("Yorishiro character preview failed", error);
    dispose();
    notify(false, "3D表示を読み込めませんでした。画像表示で続けられます");
  }
}

window.addEventListener("pagehide", dispose, { once: true });
window.addEventListener("pageshow", (event) => {
  // A bfcache entry has already relinquished its WebGL context. Rebuild the
  // page once from the prototype's saved state rather than retain a GPU scene.
  if (event.persisted && disposed) window.location.reload();
});

function initAfterPaint() {
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      void init();
    }),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initAfterPaint, { once: true });
} else {
  initAfterPaint();
}
