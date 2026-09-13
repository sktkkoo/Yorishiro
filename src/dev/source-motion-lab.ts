import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { applyVrmRestPose } from "../core/body/vrm-rest-pose";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing ${id}`);
  return found as T;
}

interface Lane {
  vrm: VRM;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  mixer: THREE.AnimationMixer;
  action: THREE.AnimationAction;
  duration: number;
}

const lanes: Lane[] = [];
const slider = element<HTMLInputElement>("time");
let elapsed = 0;
let duration = 0;
let playing = false;
const marker = new THREE.Vector3();
const sourcePath = "/.motion-review/source-assets/prepared/Idle Conversation.vrma";

async function createLane(id: string, animationPath: string): Promise<Lane> {
  const renderer = new THREE.WebGLRenderer({
    canvas: element<HTMLCanvasElement>(id),
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x1b2130);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe4edff, 0x776d7b, 2));
  const light = new THREE.DirectionalLight(0xffe5d1, 2.5);
  light.position.set(-2, 3, 4);
  scene.add(light, new THREE.GridHelper(4, 20, 0x445269, 0x2b3547));
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser));
  const model = await loader.loadAsync("/models/Yori.vrm");
  const vrm = model.userData.vrm as VRM;
  VRMUtils.rotateVRM0(vrm);
  applyVrmRestPose(vrm);
  scene.add(vrm.scene);
  const bounds = new THREE.Box3().setFromObject(vrm.scene);
  const height = bounds.max.y - bounds.min.y;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  camera.position.set(0, height * 0.55, height * 2.05);
  camera.lookAt(0, height * 0.52, 0);
  const animation = await loader.loadAsync(animationPath);
  const source = animation.userData.vrmAnimations?.[0];
  if (!source) throw new Error(`No VRMA recording: ${animationPath}`);
  const clip = createVRMAnimationClip(source, vrm);
  if (clip.tracks.some((track) => !track.values.every(Number.isFinite))) {
    throw new Error(`Invalid retargeted values: ${animationPath}`);
  }
  const mixer = new THREE.AnimationMixer(vrm.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.setEffectiveWeight(1).play();
  return { vrm, renderer, scene, camera, mixer, action, duration: clip.duration };
}

function render(): void {
  for (const { renderer, scene, camera } of lanes) {
    const canvas = renderer.domElement;
    if (canvas.width !== canvas.clientWidth || canvas.height !== canvas.clientHeight) {
      renderer.setSize(canvas.clientWidth, canvas.clientHeight, false);
      camera.aspect = canvas.clientWidth / canvas.clientHeight;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
  }
  slider.value = String(elapsed);
  element("play").textContent = playing && elapsed < duration ? "Pause" : "Play";
  element("clock").textContent = `${elapsed.toFixed(2)} / ${duration.toFixed(2)} s`;
}

function seek(time: number): void {
  elapsed = Math.max(0, Math.min(duration, time));
  for (const lane of lanes) {
    lane.action.reset().play();
    lane.mixer.setTime(elapsed);
    lane.vrm.update(0);
    lane.vrm.springBoneManager?.reset();
  }
  render();
}

function step(seconds: number): void {
  const delta = Math.max(0, Math.min(duration - elapsed, seconds));
  const frames = Math.ceil(delta * 60);
  for (let frame = 0; frame < frames; frame++) {
    const dt = Math.min(1 / 60, delta - frame / 60);
    elapsed += dt;
    for (const lane of lanes) {
      lane.mixer.update(dt);
      lane.vrm.update(dt);
    }
  }
  render();
}

function observations() {
  return {
    elapsedSeconds: elapsed,
    durationSeconds: duration,
    sourcePath,
    lanes: lanes.map((lane) => ({
      hips: lane.vrm.humanoid.getNormalizedBoneNode("hips")?.getWorldPosition(marker).toArray(),
      leftFoot: lane.vrm.humanoid
        .getNormalizedBoneNode("leftFoot")
        ?.getWorldPosition(marker)
        .toArray(),
      rightFoot: lane.vrm.humanoid
        .getNormalizedBoneNode("rightFoot")
        ?.getWorldPosition(marker)
        .toArray(),
    })),
  };
}

const api = {
  ready: false,
  seek,
  step,
  observations,
  pause: () => {
    playing = false;
    render();
  },
};
Object.assign(window, { sourceMotionLab: api });

async function start(): Promise<void> {
  lanes.push(await createLane("converted", "/animations/Idle Conversation.vrma"));
  lanes.push(await createLane("source", sourcePath));
  duration = Math.min(...lanes.map((lane) => lane.duration));
  slider.max = String(duration);
  element("play").onclick = () => {
    if (elapsed >= duration) seek(0);
    playing = !playing;
  };
  element("restart").onclick = () => seek(0);
  slider.oninput = () => {
    playing = false;
    seek(Number(slider.value));
  };
  seek(0);
  api.ready = true;
  element("status").textContent =
    "Ready · same Yori, full body, playback speed 1 · drag the timeline to inspect";
  let previous = performance.now();
  const frame = (now: number) => {
    if (playing && elapsed < duration) step(Math.min((now - previous) / 1000, 1 / 15));
    previous = now;
    render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void start().catch((error: unknown) => {
  element("status").textContent = `Source review unavailable: ${String(error)}`;
  console.error(error);
});
