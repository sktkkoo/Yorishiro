/**
 * VrmViewer — minimal Three.js + @pixiv/three-vrm renderer.
 *
 * Phase 3.5: static render only (no expressions, no animation playback).
 * Rest pose applied so the model isn't in T-pose.
 * Spring bones updated via vrm.update(delta) each frame.
 */

import { type VRM, VRMLoaderPlugin } from "@pixiv/three-vrm";
import { useEffect, useRef } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

interface VrmViewerProps {
  readonly url: string;
}

/** Lower arms from T-pose to a natural rest position. */
function setupRestPose(vrm: VRM): void {
  const humanoid = vrm.humanoid;
  if (!humanoid) return;

  const set = (name: string, axis: "x" | "y" | "z", rad: number) => {
    const bone = humanoid.getRawBoneNode(name as never);
    if (bone) bone.rotation[axis] = rad;
  };

  // Upper arms down
  set("rightUpperArm", "z", -1.35);
  set("leftUpperArm", "z", 1.35);
  set("rightUpperArm", "x", 0.1);
  set("leftUpperArm", "x", 0.1);

  // Wrists slightly straightened
  set("rightLowerArm", "z", -0.2);
  set("leftLowerArm", "z", 0.2);

  humanoid.update();
}

export default function VrmViewer({ url }: VrmViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let alive = true;
    let animationId = 0;
    let currentVrm: VRM | null = null;

    // ── Scene ─────────────────────────────────────────

    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 20);
    camera.position.set(0, 1.35, 1.1);
    camera.lookAt(0, 1.35, 0);

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
    resizeObserver.observe(canvas);

    function handleResize() {
      if (!needsResize) return;
      needsResize = false;
      const parent = canvas?.parentElement;
      if (!parent) return;
      const w = parent.clientWidth;
      const h = parent.clientHeight;
      if (w === 0 || h === 0) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    }

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
        scene.add(vrm.scene);
        currentVrm = vrm;

        // Position camera based on head bone
        const headBone = vrm.humanoid?.getRawBoneNode("head" as never);
        const chestBone = vrm.humanoid?.getRawBoneNode("chest" as never);
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

    // ── Render loop ───────────────────────────────────

    const clock = new THREE.Clock();

    function animate() {
      if (!alive) return;
      animationId = requestAnimationFrame(animate);
      const delta = clock.getDelta();
      handleResize();
      if (currentVrm) {
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
    };
  }, [url]);

  return <canvas ref={canvasRef} className="vrm-canvas" />;
}
