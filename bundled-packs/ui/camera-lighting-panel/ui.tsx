/**
 * camera-lighting-panel — Plan 2 の reference implementation。
 *
 * Tracking OFF で ctx.claim.camera() を取得し、camera position を UI pack から
 * 直接操作する。lighting は claim 対象外なので scene 内の DirectionalLight を探して
 * 直接 mutate する。
 */

import type { Disposable, UiContext, UiPackDefinition } from "@charminal/sdk";
import type React from "react";
import { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import type * as THREE from "three";
import type { DirectionalLight } from "three";

function findDirectionalLight(scene: THREE.Scene): DirectionalLight | null {
  let found: DirectionalLight | null = null;
  scene.traverse((obj) => {
    if (!found && (obj as DirectionalLight).isDirectionalLight) {
      found = obj as DirectionalLight;
    }
  });
  return found;
}

function Panel({ ctx }: { ctx: UiContext }): React.JSX.Element {
  const cameraClaimRef = useRef<Disposable | null>(null);
  const [tracking, setTracking] = useState(true);
  const [camX, setCamX] = useState(() => ctx.three.camera.position.x);
  const [camY, setCamY] = useState(() => ctx.three.camera.position.y);
  const [camZ, setCamZ] = useState(() => ctx.three.camera.position.z);
  const [fov, setFov] = useState(() => ctx.three.camera.fov);
  const [intensity, setIntensity] = useState(0.8);
  const [color, setColor] = useState("#ffffff");

  useEffect(() => {
    if (tracking) {
      cameraClaimRef.current?.dispose();
      cameraClaimRef.current = null;
    } else if (!cameraClaimRef.current) {
      cameraClaimRef.current = ctx.claim.camera();
    }

    return () => {
      cameraClaimRef.current?.dispose();
      cameraClaimRef.current = null;
    };
  }, [tracking, ctx]);

  useEffect(() => {
    if (!tracking) {
      ctx.three.camera.position.set(camX, camY, camZ);
      ctx.three.camera.lookAt(0, camY, 0);
    }
  }, [tracking, camX, camY, camZ, ctx]);

  useEffect(() => {
    ctx.three.camera.fov = fov;
    ctx.three.camera.updateProjectionMatrix();
  }, [fov, ctx]);

  useEffect(() => {
    const light = findDirectionalLight(ctx.three.scene);
    if (light) {
      light.intensity = intensity;
      light.color.set(color);
    }
  }, [intensity, color, ctx]);

  const panelStyle: React.CSSProperties = {
    background: "rgba(36, 52, 71, 0.85)",
    color: "#eceff4",
    border: "1px solid rgba(77, 217, 207, 0.4)",
    borderRadius: "8px",
    fontSize: "11px",
    fontFamily: "monospace",
    padding: "12px",
    pointerEvents: "auto",
    backdropFilter: "blur(6px)",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    minWidth: 0,
    overflow: "hidden",
  };

  const rangeStyle: React.CSSProperties = {
    width: "100%",
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: "var(--sidebar-width)",
        width: "calc(100% - var(--sidebar-width))",
        height: "20vh",
        minHeight: "180px",
        padding: "12px",
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: "12px",
        pointerEvents: "none",
        boxSizing: "border-box",
      }}
    >
      <div style={panelStyle}>
        <strong>Camera</strong>
        <label>
          <input
            type="checkbox"
            checked={tracking}
            onChange={(e) => setTracking(e.target.checked)}
          />{" "}
          Tracking
        </label>
        <label>
          X: {camX.toFixed(2)}
          <input
            type="range"
            min={-5}
            max={5}
            step={0.01}
            value={camX}
            disabled={tracking}
            style={rangeStyle}
            onChange={(e) => setCamX(Number(e.target.value))}
          />
        </label>
        <label>
          Y: {camY.toFixed(2)}
          <input
            type="range"
            min={-2}
            max={5}
            step={0.01}
            value={camY}
            disabled={tracking}
            style={rangeStyle}
            onChange={(e) => setCamY(Number(e.target.value))}
          />
        </label>
        <label>
          Z: {camZ.toFixed(2)}
          <input
            type="range"
            min={0.1}
            max={10}
            step={0.01}
            value={camZ}
            disabled={tracking}
            style={rangeStyle}
            onChange={(e) => setCamZ(Number(e.target.value))}
          />
        </label>
        <label>
          FOV: {fov.toFixed(0)}
          <input
            type="range"
            min={20}
            max={120}
            step={1}
            value={fov}
            style={rangeStyle}
            onChange={(e) => setFov(Number(e.target.value))}
          />
        </label>
      </div>
      <div style={panelStyle}>
        <strong>Lighting</strong>
        <label>
          Intensity: {intensity.toFixed(2)}
          <input
            type="range"
            min={0}
            max={3}
            step={0.01}
            value={intensity}
            style={rangeStyle}
            onChange={(e) => setIntensity(Number(e.target.value))}
          />
        </label>
        <label>
          Color <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
        </label>
      </div>
    </div>
  );
}

export default {
  id: "camera-lighting-panel",
  type: "ui",
  layout: {
    terminal: { position: "bottom" },
  },
  mount(ctx, container) {
    const root = ReactDOM.createRoot(container);
    root.render(<Panel ctx={ctx} />);
    return {
      dispose: () => {
        root.unmount();
      },
    };
  },
} satisfies UiPackDefinition;
