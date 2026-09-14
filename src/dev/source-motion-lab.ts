import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import { createVRMAnimationClip, VRMAnimationLoaderPlugin } from "@pixiv/three-vrm-animation";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { AnimationPlayer } from "../core/body/animation-player";
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
  player?: AnimationPlayer;
  duration: number;
}

const lanes: Lane[] = [];
const slider = element<HTMLInputElement>("time");
let elapsed = 0;
let duration = 0;
let playing = false;
let seekGeneration = 0;
let seeking = false;
const marker = new THREE.Vector3();
const contactReview = new URLSearchParams(window.location.search).get("contacts") === "1";
const runtimeReview = new URLSearchParams(window.location.search).get("runtime") === "1";
const faithfulPath = "/.motion-review/source-assets/prepared/Idle Conversation.vrma";
const sourcePath = contactReview
  ? "/.motion-review/source-assets/prepared/Idle Conversation.yori-contact.vrma"
  : faithfulPath;
const leftPath = runtimeReview
  ? sourcePath
  : contactReview
    ? faithfulPath
    : "/animations/Idle Conversation.vrma";

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
  const player = runtimeReview && id === "source" ? new AnimationPlayer(vrm) : undefined;
  if (player) {
    await player.preload(animationPath, { rootMotion: "preserve" });
  } else action.setEffectiveWeight(1).play();
  return { vrm, renderer, scene, camera, mixer, action, player, duration: clip.duration };
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

async function seek(time: number): Promise<void> {
  const generation = ++seekGeneration;
  seeking = true;
  playing = false;
  elapsed = Math.max(0, Math.min(duration, time));
  await Promise.all(
    lanes.map(async (lane) => {
      if (lane.player) {
        lane.player.stopAll();
        try {
          await lane.player.play(sourcePath, {
            rootMotion: "preserve",
            loop: false,
            transition: "immediate",
            weight: 1,
            speed: 1,
            fadeInMs: 0,
            startTimeSec: elapsed,
            isCurrent: () => generation === seekGeneration,
          });
        } catch (error) {
          if (generation !== seekGeneration) return;
          throw error;
        }
        if (generation !== seekGeneration) return;
        lane.player.update(0);
      } else {
        lane.action.reset().play();
        lane.mixer.setTime(elapsed);
      }
      lane.vrm.update(0);
      lane.vrm.springBoneManager?.reset();
    }),
  );
  if (generation !== seekGeneration) return;
  seeking = false;
  render();
}

function step(seconds: number): void {
  if (seeking) return;
  const delta = Math.max(0, Math.min(duration - elapsed, seconds));
  const frames = Math.ceil(delta * 60);
  for (let frame = 0; frame < frames; frame++) {
    const dt = Math.min(1 / 60, delta - frame / 60);
    elapsed += dt;
    for (const lane of lanes) {
      if (lane.player) lane.player.update(dt);
      else lane.mixer.update(dt);
      lane.vrm.update(dt);
    }
  }
  render();
}

function observations() {
  return {
    elapsedSeconds: elapsed,
    durationSeconds: duration,
    comparison: runtimeReview
      ? "runtime-root-preservation"
      : contactReview
        ? "target-contact-adaptation"
        : "source-conversion",
    leftPath,
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
  if (runtimeReview) {
    element("left-title").textContent = "Official loader · direct replay";
    element("right-title").textContent = "Yorishiro AnimationPlayer · root preserved";
    element("left-caption").textContent = "Direct reference playback of the same prepared clip.";
    element("right-caption").textContent =
      "The actual runtime player, with explicit whole-body root preservation.";
    element("comparison-note").textContent =
      "Both lanes use the same clip, Yori model, time, full weight and playback speed 1. The right uses the actual AnimationPlayer with rootMotion: preserve, a finite performance and no body mask. This checks runtime ingestion; it does not approve cross-clip transitions or Animates superiority.";
  } else if (contactReview) {
    element("left-title").textContent = "Faithful source · direct retarget";
    element("right-title").textContent = "Yori · contact adaptation candidate";
    element("left-caption").textContent = "Original full-body recording, with hips and fingers.";
    element("right-caption").textContent =
      "The same performance with offline support correction for this Yori model. Review pending.";
    element("comparison-note").textContent =
      "Same Yori, camera, lighting and source time. Both use full weight and playback speed 1, with no runtime procedural overlays, masks or loop repair. The right clip contains target-specific offline contact adaptation. This is a contact review, not an Animates comparison or production quality approval.";
  }
  lanes.push(await createLane("converted", leftPath));
  lanes.push(await createLane("source", sourcePath));
  duration = Math.min(...lanes.map((lane) => lane.duration));
  slider.max = String(duration);
  element("play").onclick = async () => {
    if (elapsed >= duration) await seek(0);
    playing = !playing;
  };
  element("restart").onclick = () => void seek(0);
  slider.oninput = () => {
    playing = false;
    void seek(Number(slider.value));
  };
  await seek(0);
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
