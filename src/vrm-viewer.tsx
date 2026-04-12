/**
 * VrmViewer — minimal Three.js + @pixiv/three-vrm renderer.
 *
 * Phase 3.5: static render only (no expressions, no animation playback).
 * Rest pose applied so the model isn't in T-pose.
 * Spring bones updated via vrm.update(delta) each frame.
 */

import { type VRM, type VRMHumanBoneName, VRMLoaderPlugin } from "@pixiv/three-vrm";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { applyBreathing, BlinkSystem, IdleEyeSystem } from "./vrm-procedural";

interface VrmViewerProps {
  readonly url: string;
}

/** Lower arms from T-pose to a natural rest position. */
function setupRestPose(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  const set = (name: VRMHumanBoneName, axis: "x" | "y" | "z", rad: number) => {
    const bone = humanoid.getNormalizedBoneNode(name);
    if (bone) bone.rotation[axis] = rad;
  };

  // Upper arms down
  set("rightUpperArm", "z", -1.35);
  set("leftUpperArm", "z", 1.35);
  set("rightUpperArm", "x", 0.1);
  set("leftUpperArm", "x", 0.1);

  // Lower arms slightly bent
  set("rightLowerArm", "z", -0.2);
  set("leftLowerArm", "z", 0.2);
}

export default function VrmViewer({ url }: VrmViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let alive = true;
    let animationId = 0;
    let currentVrm: VRM | null = null;

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
        currentVrm = vrm;

        // Force one update so world positions are ready for camera calc
        vrm.update(0);

        // Position camera based on head/chest bones
        const headBone = vrm.humanoid?.getNormalizedBoneNode("head");
        const chestBone = vrm.humanoid?.getNormalizedBoneNode("chest");
        if (headBone && chestBone) {
          const headPos = new THREE.Vector3();
          const chestPos = new THREE.Vector3();
          headBone.getWorldPosition(headPos);
          chestBone.getWorldPosition(chestPos);
          const targetY = headPos.y * 0.6 + chestPos.y * 0.4 - 0.1;
          camera.position.set(0, targetY, 1.1);
          camera.lookAt(0, targetY, 0);
        }
      },
      undefined,
      (err) => {
        if (alive) console.error("[vrm-viewer] load failed:", err);
      },
    );

    // ── Procedural subsystems ─────────────────────────

    const blinkSystem = new BlinkSystem();
    const eyeSystem = new IdleEyeSystem();

    // ── Render loop ───────────────────────────────────

    const clock = new THREE.Clock();

    function animate() {
      if (!alive) return;
      animationId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      const elapsed = clock.getElapsedTime();
      handleResize();
      if (currentVrm) {
        // Procedural animation — handler 不要で常時動く生体運動
        applyBreathing(currentVrm, elapsed);
        blinkSystem.update(delta);
        blinkSystem.apply(currentVrm);
        eyeSystem.update(delta);
        eyeSystem.apply(currentVrm);

        currentVrm.update(delta);
      }
      renderer.render(scene, camera);
    }
    animationId = requestAnimationFrame(animate);

    // ── Cleanup ───────────────────────────────────────

    return () => {
      alive = false;
      cancelAnimationFrame(animationId);
      resizeObserver.disconnect();

      if (currentVrm) {
        scene.remove(currentVrm.scene);
        currentVrm.scene.traverse((obj) => {
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
      renderer.dispose();
      canvas.remove();
    };
  }, [url]);

  return <div ref={containerRef} className="vrm-container" />;
}
