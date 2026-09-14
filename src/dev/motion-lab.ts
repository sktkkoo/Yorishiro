import { type VRM, VRMLoaderPlugin, VRMUtils } from "@pixiv/three-vrm";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Body } from "../core/body";
import {
  createSeededMotionRandom,
  DEFAULT_MOTION_CATALOG,
  type MotionIntent,
} from "../core/body/motion-catalog";
import { applyVrmRestPose } from "../core/body/vrm-rest-pose";
import { MotionLabSpeech } from "./motion-lab-speech";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing ${id}`);
  return found as T;
}

interface Lane {
  body: Body;
  vrm: VRM;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  samples: {
    at: number;
    animation: string | null;
    recordedBody: ReturnType<Body["getRecordedBodySnapshot"]>;
    head: number[];
    leftHand: number[];
    rightHand: number[];
    hips: number[];
    leftFoot: number[];
    rightFoot: number[];
    leftToes: number[];
    rightToes: number[];
  }[];
}

const lanes: Lane[] = [];
let elapsed = 0;
let paused = new URLSearchParams(window.location.search).has("manual");
let manual = false;
let nextSample = 0;
const status = element("status");
const point = new THREE.Vector3();
let speech: MotionLabSpeech | null = null;

async function createLane(id: string, recorded: boolean): Promise<Lane> {
  const canvas = element<HTMLCanvasElement>(id);
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  renderer.setPixelRatio(1);
  renderer.setClearColor(0x1b2130);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xe4edff, 0x776d7b, 2));
  const key = new THREE.DirectionalLight(0xffe5d1, 2.5);
  key.position.set(-2, 3, 4);
  scene.add(key);
  const grid = new THREE.GridHelper(4, 20, 0x445269, 0x2b3547);
  scene.add(grid);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const bytes = await fetch("/models/Yori.vrm").then((response) => response.arrayBuffer());
  const modelSha256 = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const gltf = await loader.parseAsync(bytes, "");
  const vrm = gltf.userData.vrm as VRM;
  VRMUtils.rotateVRM0(vrm);
  applyVrmRestPose(vrm);
  scene.add(vrm.scene);
  const bounds = new THREE.Box3().setFromObject(vrm.scene);
  const height = bounds.max.y - bounds.min.y;
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 100);
  camera.position.set(0, height * 0.55, height * 2.05);
  camera.lookAt(0, height * 0.52, 0);
  const previousRandom = Math.random;
  Math.random = createSeededMotionRandom(738);
  let body: Body;
  try {
    body = new Body(vrm, undefined, undefined, { modelSha256 });
  } finally {
    Math.random = previousRandom;
  }
  body.setMotionLibraryEnabled(recorded);
  await body.prepareMotionLibrary();
  await body.initializeRecordedBody();
  return { body, vrm, scene, renderer, camera, samples: [] };
}

function render(): void {
  for (const lane of lanes) {
    const { renderer, camera, scene } = lane;
    const canvas = renderer.domElement;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width || canvas.height !== height) {
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    }
    renderer.render(scene, camera);
  }
}

function advance(delta: number): void {
  elapsed += delta;
  for (const lane of lanes) {
    lane.body.update(delta, elapsed);
  }
  if (elapsed >= nextSample) {
    nextSample = elapsed + 0.1;
    for (const lane of lanes) {
      lane.vrm.scene.updateMatrixWorld(true);
      const position = (
        name:
          | "head"
          | "leftHand"
          | "rightHand"
          | "hips"
          | "leftFoot"
          | "rightFoot"
          | "leftToes"
          | "rightToes",
      ) => {
        const bone = lane.vrm.humanoid.getNormalizedBoneNode(name);
        if (!bone) return [];
        return bone.getWorldPosition(point).toArray();
      };
      lane.samples.push({
        at: elapsed,
        animation: lane.body.getMotionSnapshot().active?.animation ?? null,
        recordedBody: lane.body.getRecordedBodySnapshot(),
        head: position("head"),
        leftHand: position("leftHand"),
        rightHand: position("rightHand"),
        hips: position("hips"),
        leftFoot: position("leftFoot"),
        rightFoot: position("rightFoot"),
        leftToes: position("leftToes"),
        rightToes: position("rightToes"),
      });
      if (lane.samples.length > 6_000) lane.samples.shift();
    }
    const current = lanes[1]?.body.getMotionDirectorSnapshot();
    const active = lanes[1]?.body.getMotionSnapshot().active;
    const recordedBody = lanes[1]?.body.getRecordedBodySnapshot().active;
    element("recorded-caption").textContent = recordedBody
      ? `${recordedBody.id} · ${recordedBody.phaseSec.toFixed(2)} s · ${recordedBody.held ? "transition" : "full body"}${active ? ` + ${active.animation}` : ""}`
      : `${active?.animation ?? "Settling"} · ${current?.phase ?? "loading"} · ${elapsed.toFixed(1)} s`;
  }
}

function gesture(intent: MotionIntent): void {
  lanes[1]?.body.acquireSemanticMotion({
    source: "system",
    priority: "speech-expression",
    context: "speech",
    intent,
    intensity: 0.6,
  });
}

function speaking(): void {
  speech?.stop();
  for (const lane of lanes) {
    lane.body.setState("idle");
    lane.body.setMotionConversationPhase("assistant-speaking");
  }
}

function listening(): void {
  speech?.stop();
  for (const lane of lanes) {
    lane.body.setState("idle");
    lane.body.setMotionConversationPhase("user-speaking");
  }
}

async function step(seconds: number): Promise<void> {
  speech?.stop("Speech stopped for deterministic stepping");
  manual = true;
  paused = true;
  const duration = Math.max(0, Math.min(600, seconds));
  const frames = Math.ceil(duration * 60);
  for (let frame = 0; frame < frames; frame++) {
    advance(Math.min(1 / 60, duration - frame / 60));
    await Promise.resolve();
  }
  render();
}

function observations() {
  return {
    kind: "yorishiro-motion-lab-diagnostic",
    elapsedSeconds: elapsed,
    seed: 738,
    speech: speech?.snapshot(),
    baseline: { samples: lanes[0]?.samples },
    recorded: { director: lanes[1]?.body.getMotionDirectorSnapshot(), samples: lanes[1]?.samples },
    limitation:
      "Diagnostic only; no Animates superiority or human preference has been established.",
  };
}

async function playClip(animation: string, matched = true): Promise<void> {
  speech?.stop();
  lanes[1]?.body.acquireMotionSlot({
    source: "mcp",
    priority: "mcp-conscious",
    animation,
    options: {
      loop: true,
      weight: 0.9,
      mask: "upper-body",
      transition: matched ? "matched" : "immediate",
      fadeInMs: 1_200,
    },
  });
  await Promise.resolve();
}

Object.assign(window, {
  motionLab: {
    ready: false,
    step,
    gesture,
    speaking,
    listening,
    playClip,
    observations,
    pause: () => {
      speech?.stop("Speech stopped while the lab is paused");
      paused = true;
    },
  },
});

async function start(): Promise<void> {
  lanes.push(await createLane("baseline", false));
  lanes.push(await createLane("recorded", true));
  speech = new MotionLabSpeech(
    lanes.map((lane) => lane.body),
    (state) => {
      element("speech-status").textContent = state.message;
      element("speech-text").textContent = state.text;
      element<HTMLButtonElement>("stop-speech").disabled =
        state.status !== "playing" && state.status !== "loading";
    },
  );
  element<HTMLButtonElement>("play-speech").disabled = false;
  element("play-speech").onclick = () => {
    paused = false;
    manual = false;
    element("pause").textContent = "Pause";
    for (const lane of lanes) {
      lane.body.createCharacterAPI().interrupt("local-speech-review");
      lane.body.setState("idle");
    }
    void speech?.play();
  };
  element("stop-speech").onclick = () => speech?.stop();
  const select = element<HTMLSelectElement>("clip");
  for (const entry of DEFAULT_MOTION_CATALOG) {
    const option = document.createElement("option");
    option.value = entry.animation;
    option.textContent = entry.animation.slice(5);
    select.append(option);
  }
  element("pause").onclick = () => {
    speech?.stop("Speech stopped while changing playback mode");
    paused = !paused;
    manual = false;
    element("pause").textContent = paused ? "Play" : "Pause";
  };
  element("idle").onclick = () => {
    speech?.stop();
    for (const lane of lanes) {
      lane.body.setState("idle");
      lane.body.setMotionConversationPhase("idle");
    }
  };
  element("listening").onclick = listening;
  element("speaking").onclick = speaking;
  element("thinking").onclick = () => {
    speech?.stop();
    for (const lane of lanes) {
      lane.body.setState("thinking");
      lane.body.setMotionConversationPhase("assistant-responding");
    }
  };
  element("interrupt").onclick = () => {
    speech?.stop("Speech interrupted");
    for (const lane of lanes) {
      lane.body.setMotionConversationPhase("interrupted");
      lane.body.createCharacterAPI().interrupt("motion-lab");
    }
  };
  element("play-clip").onclick = () => {
    void playClip(select.value);
  };
  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-intent]")) {
    button.onclick = () => gesture(button.dataset.intent as MotionIntent);
  }
  element("export").onclick = () => {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(observations(), null, 2)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = "yorishiro-motion-observations.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  Object.assign((window as unknown as { motionLab: object }).motionLab, { ready: true });
  status.textContent = "Ready · same avatar / lighting / camera · local assets";
  let previous = performance.now();
  const frame = (now: number) => {
    const delta = Math.max(0, (now - previous) / 1000);
    speech?.sampleFrame();
    if (!paused && !manual) {
      if (speech?.isBusy() && delta > 0.25) {
        // A suspended/overloaded tab cannot truthfully replay delayed gestures
        // against audio that has already advanced. Stop and let the user restart.
        speech.stop("Speech stopped after a browser delay; press Play to restart");
        advance(1 / 60);
      } else if (speech?.isBusy()) {
        const frames = Math.ceil(delta * 60);
        for (let i = 0; i < frames; i++) advance(Math.min(1 / 60, delta - i / 60));
      } else advance(Math.min(delta, 1 / 15));
    }
    previous = now;
    render();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  window.addEventListener("pagehide", () => speech?.dispose(), { once: true });
}

void start().catch((error: unknown) => {
  status.textContent = `Motion lab failed: ${String(error)}`;
  console.error(error);
});
