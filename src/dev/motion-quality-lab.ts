import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Body, type MotionConversationPhase } from "../core/body";
import { createSeededMotionRandom, type MotionIntent } from "../core/body/motion-catalog";
import { applyVrmRestPose } from "../core/body/vrm-rest-pose";
import {
  defaultCameraForCharacter,
  TERMINAL_CAMERA_HEAD_OFFSET_Y,
} from "../runtime/view-mode-framing";

// Development-only observation adapter. Private player access deliberately stays
// here so the same harness can inspect an older checkout without changing Body.
interface ObservedPlayer {
  active: Map<
    number,
    {
      id: number;
      ref: string;
      layer: string;
      action: THREE.AnimationAction;
      stopAt?: number;
    }
  >;
}
interface ObservedBody {
  animationPlayer: ObservedPlayer;
  getComposedMotionSnapshot?: (includeFrames?: boolean) => unknown;
}

const bones: readonly VRMHumanBoneName[] = [
  "hips",
  "spine",
  "chest",
  "upperChest",
  "neck",
  "head",
  "leftShoulder",
  "leftUpperArm",
  "leftLowerArm",
  "leftHand",
  "rightShoulder",
  "rightUpperArm",
  "rightLowerArm",
  "rightHand",
  "leftUpperLeg",
  "leftLowerLeg",
  "leftFoot",
  "leftToes",
  "rightUpperLeg",
  "rightLowerLeg",
  "rightFoot",
  "rightToes",
];
const parameters = new URLSearchParams(location.search);
const seed = Number(parameters.get("seed") ?? 738);
const label = parameters.get("label") ?? "review";
const position = new THREE.Vector3();
const inverse = new THREE.Matrix4();
const headPosition = new THREE.Vector3();
function element(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing review element: ${id}`);
  return found;
}
const status = element("status");
const state = element("state");
let elapsed = 0;
let live = false;
let previousWall = 0;
let phase: MotionConversationPhase = "idle";
let scenario = "idle-normal";
let intensity = 1;
let body: Body;
let vrm: VRM;
let renderer: THREE.WebGLRenderer;
let scene: THREE.Scene;
let cameras: THREE.PerspectiveCamera[];
let frames: ReturnType<typeof sample>[] = [];
let wallFrames: { at: number; wallMs: number; deltaMs: number }[] = [];
let commands: { at: number; command: unknown }[] = [];
let modelSha256 = "";
let headBone: THREE.Object3D;

function actions() {
  return [...(body as unknown as ObservedBody).animationPlayer.active.values()].map((entry) => ({
    id: entry.id,
    animation: entry.ref,
    layer: entry.layer,
    phaseSec: entry.action.time,
    weight: entry.action.getEffectiveWeight(),
    speed: entry.action.getEffectiveTimeScale(),
    paused: entry.action.paused,
    fading: entry.stopAt !== undefined,
  }));
}

function sample(delta: number) {
  vrm.scene.updateMatrixWorld(true);
  inverse.copy(vrm.scene.matrixWorld).invert();
  const pose: number[] = [];
  for (const name of bones) {
    const bone = vrm.humanoid.getNormalizedBoneNode(name);
    if (!bone) throw new Error(`Missing review bone: ${name}`);
    pose.push(...bone.quaternion.toArray());
    bone.getWorldPosition(position).applyMatrix4(inverse);
    pose.push(...position.toArray());
  }
  const recorded = body.getRecordedBodySnapshot();
  const selected = body.getMotionSnapshot().active;
  return {
    at: elapsed,
    delta,
    scenario,
    phase,
    intensity,
    pose,
    actions: actions(),
    selected: selected
      ? { animation: selected.animation, source: selected.source, priority: selected.priority }
      : null,
    recorded: {
      active: recorded.active,
      intensity: recorded.intensity,
      postureVariation: recorded.postureVariation,
    },
    terminalCamera: cameras[2].position.toArray(),
  };
}

function advance(delta: number) {
  elapsed += delta;
  body.update(delta, elapsed);
  headBone.getWorldPosition(headPosition);
  const camera = cameras[2];
  camera.position.y +=
    (headPosition.y + TERMINAL_CAMERA_HEAD_OFFSET_Y - camera.position.y) * Math.min(1.5 * delta, 1);
  camera.lookAt(camera.position.x, camera.position.y, 0);
  frames.push(sample(delta));
}

function render() {
  renderer.setScissorTest(true);
  const widths = [500, 500, 400];
  let x = 0;
  for (let index = 0; index < cameras.length; index++) {
    renderer.setViewport(x, 0, widths[index], 640);
    renderer.setScissor(x, 0, widths[index], 640);
    renderer.render(scene, cameras[index]);
    x += widths[index];
  }
  const active = actions().filter((entry) => entry.layer === "performance");
  state.textContent = `${label} · ${elapsed.toFixed(2)} s · ${scenario} · intensity ${intensity} · ${active.map((entry) => `${entry.animation} @ ${entry.phaseSec.toFixed(2)} s / ${entry.weight.toFixed(2)}`).join(" + ") || "recorded support / procedural upper"}`;
}

async function step(seconds: number) {
  live = false;
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 10)
    throw new Error("Step must be 0–10 seconds");
  const count = Math.ceil(seconds * 60);
  for (let index = 0; index < count; index++) {
    advance(Math.min(1 / 60, seconds - index / 60));
    // Let deferred preparation, completion and owner changes settle each frame.
    await Promise.resolve();
  }
  render();
}

function command(input: {
  phase?: MotionConversationPhase;
  intensity?: number;
  gesture?: MotionIntent;
  scenario?: string;
}) {
  commands.push({ at: elapsed, command: input });
  if (input.scenario) scenario = input.scenario;
  if (input.intensity !== undefined) {
    intensity = input.intensity;
    body.setMotionIntensity(intensity);
  }
  if (input.phase) {
    phase = input.phase;
    body.setState(phase === "assistant-responding" ? "thinking" : "idle");
    body.setMotionConversationPhase(phase);
    if (phase === "interrupted") body.createCharacterAPI().interrupt("motion-quality-review");
  }
  if (input.gesture)
    body.acquireSemanticMotion({
      source: "system",
      priority: "speech-expression",
      context: "speech",
      intent: input.gesture,
      intensity: 0.6,
    });
}

function drain() {
  const result = { frames, wallFrames, commands };
  frames = [];
  wallFrames = [];
  commands = [];
  return result;
}

function snapshot() {
  return {
    elapsed,
    label,
    seed,
    modelSha256,
    bones,
    stride: 7,
    poseLayout: "normalized local quaternion xyzw; avatar-space joint origin xyz, metres",
    cameras: cameras.map((camera) => ({
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      fov: camera.fov,
      aspect: camera.aspect,
    })),
    recorded: body.getRecordedBodySnapshot(),
    director: body.getMotionDirectorSnapshot(),
    composed: (body as unknown as ObservedBody).getComposedMotionSnapshot?.(true) ?? null,
    sample: sample(0),
  };
}

async function start() {
  renderer = new THREE.WebGLRenderer({
    canvas: document.getElementById("review") as HTMLCanvasElement,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setSize(1400, 640, false);
  renderer.setClearColor(0x202737);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe4edff, 0x776d7b, 2));
  const key = new THREE.DirectionalLight(0xffe5d1, 2.5);
  key.position.set(-2, 3, 4);
  scene.add(key, new THREE.GridHelper(4, 20, 0x55627a, 0x344056));
  const response = await fetch("/models/Yori.vrm");
  if (!response.ok) throw new Error(`Yori model HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  modelSha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  vrm = (await loader.parseAsync(bytes, "")).userData.vrm as VRM;
  VRMUtils.rotateVRM0(vrm);
  applyVrmRestPose(vrm);
  scene.add(vrm.scene);
  // Isolated QA page only. Keep random choices reproducible throughout the run,
  // not just construction; callbacks can call Math.random long after startup.
  Math.random = createSeededMotionRandom(seed);
  body = new Body(vrm, undefined, undefined, { modelSha256 });
  body.setMotionIntensity(1);
  await body.prepareMotionLibrary();
  await body.initializeRecordedBody();
  vrm.scene.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(vrm.scene);
  const height = bounds.max.y - bounds.min.y;
  const front = new THREE.PerspectiveCamera(30, 500 / 640, 0.01, 100);
  front.position.set(0, height * 0.55, height * 2.05);
  front.lookAt(0, height * 0.52, 0);
  const side = front.clone();
  side.position.set(height * 2.05, height * 0.55, 0);
  side.lookAt(0, height * 0.52, 0);
  const foundHead = vrm.humanoid.getNormalizedBoneNode("head");
  if (!foundHead) throw new Error("Missing head bone");
  headBone = foundHead;
  headBone.getWorldPosition(headPosition);
  const framing = defaultCameraForCharacter(headPosition);
  const terminal = new THREE.PerspectiveCamera(35, 400 / 640, 0.1, 20);
  terminal.position.set(framing.x, framing.y, framing.z);
  terminal.lookAt(framing.x, framing.y, 0);
  cameras = [front, side, terminal];
  body.setMotionConversationPhase("idle");
  render();
  Object.assign(window, {
    motionQualityLab: {
      ready: true,
      step,
      command,
      drain,
      snapshot,
      live: (enabled: boolean) => {
        live = enabled;
        previousWall = performance.now();
      },
    },
  });
  status.textContent = `${label} · Yori ${modelSha256.slice(0, 12)} · seed ${seed} · ready`;
  const frame = (now: number) => {
    if (live) {
      const delta = Math.max(0, (now - previousWall) / 1000);
      wallFrames.push({ at: elapsed, wallMs: now, deltaMs: delta * 1000 });
      // No clamp or fixed-step film resampling: stalls remain in the evidence.
      advance(delta);
      render();
    }
    previousWall = now;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

void start().catch((error: unknown) => {
  status.textContent = `Failed: ${String(error)}`;
  console.error(error);
});
