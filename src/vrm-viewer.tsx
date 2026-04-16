/**
 * VrmViewer — Three.js + @pixiv/three-vrm renderer, delegating to Body primitive.
 *
 * Responsibilities (renderer only):
 * - Canvas, WebGLRenderer, Scene, Camera, Lighting
 * - Resize handling via ResizeObserver
 * - VRM loading via GLTFLoader + VRMLoaderPlugin
 * - Camera auto-follow (head bone tracking)
 *
 * Body primitive owns all VRM manipulation:
 * - Procedural animation (breathing, blink, idle eye)
 * - Expression blending
 * - VRMA clip playback
 * - Gaze control
 *
 * Body instance is surfaced via onBodyReady callback so the
 * runtime stack can wire it into PersonaContext.character.
 */

import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin } from "@pixiv/three-vrm";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Body } from "./core/body";
import type { SubsystemLog } from "./core/dev-log";

interface VrmViewerProps {
  readonly url: string;
  readonly onBodyReady?: (body: Body | null) => void;
  readonly devLog?: SubsystemLog;
}

/**
 * Lower arms from T-pose to a natural rest position + relaxed finger curl.
 * Ported from old Charminal's bodySystem.ts setupRestPose.
 */
function setupRestPose(vrm: VRM): void {
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

export default function VrmViewer({ url, onBodyReady, devLog }: VrmViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let alive = true;
    let animationId = 0;
    let currentBody: Body | null = null;
    let trackHead: THREE.Object3D | null = null;
    const headWorldPos = new THREE.Vector3();

    // ── Scene ─────────────────────────────────────────

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(0, 1.35, 1.1);
    camera.lookAt(0, 1.35, 0);

    const canvas = document.createElement("canvas");
    container.appendChild(canvas);

    const renderer = new THREE.WebGLRenderer({
      canvas,
      alpha: true,
      antialias: false,
      powerPreference: "low-power",
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);

    // Lighting
    scene.add(new THREE.AmbientLight(0xffffff, 0.4));
    const dirLight = new THREE.DirectionalLight(0xffffff, 0.8);
    dirLight.position.set(1, 2, 2);
    scene.add(dirLight);

    // ── Resize ────────────────────────────────────────

    let needsResize = true;

    const resizeObserver = new ResizeObserver(() => {
      needsResize = true;
    });
    resizeObserver.observe(container);

    function handleResize() {
      if (!needsResize || !container) return;
      needsResize = false;
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

    // Initial size
    handleResize();

    // ── Load VRM ──────────────────────────────────────

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    loader.load(
      url,
      (gltf) => {
        if (!alive) return;
        const vrm = gltf.userData.vrm as VRM;
        if (!vrm) return;

        vrm.scene.rotation.y = Math.PI;
        setupRestPose(vrm);

        // Propagate normalized bone rotations to raw bones
        vrm.humanoid?.update();

        scene.add(vrm.scene);

        // Create Body primitive — owns all VRM manipulation
        currentBody = new Body(vrm, devLog);
        onBodyReady?.(currentBody);

        // Force world matrix update so bone world positions are accurate
        vrm.scene.updateWorldMatrix(true, true);
        vrm.update(0);

        // Camera initial placement — head bone based
        const headBone = vrm.humanoid?.getNormalizedBoneNode("head");
        trackHead = headBone ?? null;

        const headPos = new THREE.Vector3();
        if (headBone) headBone.getWorldPosition(headPos);
        else headPos.set(0, 1.6, 0);

        const targetY = headPos.y - 0.05;
        camera.position.set(0, targetY, 1.1);
        camera.lookAt(0, targetY, 0);
      },
      undefined,
      (err) => {
        if (alive) console.error("[vrm-viewer] load failed:", err);
      },
    );

    // ── Render loop ───────────────────────────────────

    const clock = new THREE.Clock();

    function animate() {
      if (!alive) return;
      animationId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      const elapsed = clock.getElapsedTime();
      handleResize();

      if (currentBody) {
        // Body drives all VRM subsystems (blink, eye, expressions, animation, breathing, spring bones)
        currentBody.update(delta, elapsed);

        // Camera auto-follow: smoothly track head bone Y
        if (trackHead) {
          trackHead.getWorldPosition(headWorldPos);
          const desiredY = headWorldPos.y - 0.05;
          camera.position.y += (desiredY - camera.position.y) * Math.min(1.5 * delta, 1);
          camera.lookAt(0, camera.position.y, 0);
        }
      }
      renderer.render(scene, camera);
    }
    animationId = requestAnimationFrame(animate);

    // ��─ Cleanup ───────────────────────────────────────

    return () => {
      alive = false;
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();

      if (currentBody) {
        currentBody.dispose();
        onBodyReady?.(null);

        // Remove VRM scene (Body doesn't own the scene graph)
        const vrmScene = scene.children.find((c) => c.rotation.y === Math.PI);
        if (vrmScene) {
          scene.remove(vrmScene);
          vrmScene.traverse((obj) => {
            if (obj instanceof THREE.Mesh) {
              obj.geometry?.dispose();
              if (Array.isArray(obj.material)) {
                for (const mat of obj.material) mat.dispose();
              } else {
                obj.material?.dispose();
              }
            }
          });
        }
      }
      renderer.dispose();
      canvas.remove();
    };
  }, [url, onBodyReady, devLog]);

  return <div ref={containerRef} className="vrm-container" />;
}
