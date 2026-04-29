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

const PANEL_HEIGHT = "clamp(340px, 42vh, 460px)";
const DEFAULT_TARGET_X = 0;
const DEFAULT_TARGET_Z = 0;
const STATE_KEYS = {
  tracking: "camera.tracking",
  targetLock: "camera.lookAtCharacter",
  camX: "camera.x",
  camY: "camera.y",
  camZ: "camera.z",
  fov: "camera.fov",
  intensity: "lighting.intensity",
  color: "lighting.color",
  backgroundBlur: "scene.background.blur",
  backgroundSrc: "scene.background.src",
  backgroundMediaType: "scene.background.mediaType",
  backgroundName: "scene.background.name",
  foregroundBlur: "scene.foreground.blur",
  foregroundSrc: "scene.foreground.src",
  foregroundMediaType: "scene.foreground.mediaType",
  foregroundName: "scene.foreground.name",
} as const;

function booleanState(ctx: UiContext, key: string, fallback: boolean): boolean {
  const value = ctx.state.get(key);
  return typeof value === "boolean" ? value : fallback;
}

function stringState(ctx: UiContext, key: string, fallback: string): string {
  const value = ctx.state.get(key);
  return typeof value === "string" ? value : fallback;
}

function mediaTypeState(ctx: UiContext, key: string): "image" | "video" | null {
  const value = ctx.state.get(key);
  return value === "image" || value === "video" ? value : null;
}

function layerBlur(ctx: UiContext, role: "background" | "foreground", fallback: number): number {
  const layer = ctx.scene.get()?.layers.find((candidate) => candidate.role === role);
  return typeof layer?.blur === "number" ? layer.blur : fallback;
}

function fileMediaType(file: File): "image" | "video" {
  return file.type.startsWith("video/") ? "video" : "image";
}

function revokeObjectUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}

function clearVolatileMediaState(
  ctx: UiContext,
  srcKey: string,
  mediaTypeKey: string,
  nameKey: string,
  src: string,
): void {
  if (!src.startsWith("blob:")) return;
  ctx.state.set(srcKey, "");
  ctx.state.set(mediaTypeKey, null);
  ctx.state.set(nameKey, "");
}

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
  const [tracking, setTracking] = useState(() =>
    ctx.claim.isClaimed("camera") ? false : booleanState(ctx, STATE_KEYS.tracking, true),
  );
  const [camX, setCamX] = useState(() => ctx.three.camera.position.x);
  const [camY, setCamY] = useState(() => ctx.three.camera.position.y);
  const [camZ, setCamZ] = useState(() => ctx.three.camera.position.z);
  const [fov, setFov] = useState(() => ctx.three.camera.fov);
  const [intensity, setIntensity] = useState(() => {
    const light = findDirectionalLight(ctx.three.scene);
    return light ? light.intensity : 0.8;
  });
  const [color, setColor] = useState(() => {
    const light = findDirectionalLight(ctx.three.scene);
    return light ? `#${light.color.getHexString()}` : "#ffffff";
  });
  const [targetLock, setTargetLock] = useState(() =>
    booleanState(ctx, STATE_KEYS.targetLock, true),
  );
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const foregroundInputRef = useRef<HTMLInputElement | null>(null);
  const [backgroundBlur, setBackgroundBlur] = useState(() => layerBlur(ctx, "background", 0));
  const [foregroundBlur, setForegroundBlur] = useState(() => layerBlur(ctx, "foreground", 0));
  const [backgroundSrc, setBackgroundSrc] = useState(() =>
    stringState(ctx, STATE_KEYS.backgroundSrc, ""),
  );
  const [foregroundSrc, setForegroundSrc] = useState(() =>
    stringState(ctx, STATE_KEYS.foregroundSrc, ""),
  );
  const [backgroundMediaType, setBackgroundMediaType] = useState<"image" | "video" | null>(() =>
    mediaTypeState(ctx, STATE_KEYS.backgroundMediaType),
  );
  const [foregroundMediaType, setForegroundMediaType] = useState<"image" | "video" | null>(() =>
    mediaTypeState(ctx, STATE_KEYS.foregroundMediaType),
  );
  const [backgroundName, setBackgroundName] = useState(() =>
    stringState(ctx, STATE_KEYS.backgroundName, ""),
  );
  const [foregroundName, setForegroundName] = useState(() =>
    stringState(ctx, STATE_KEYS.foregroundName, ""),
  );
  const backgroundSrcRef = useRef(backgroundSrc);
  const foregroundSrcRef = useRef(foregroundSrc);

  useEffect(() => {
    const subs = [
      ctx.state.subscribe(STATE_KEYS.tracking, (value) => {
        if (typeof value === "boolean") setTracking(value);
      }),
      ctx.state.subscribe(STATE_KEYS.targetLock, (value) => {
        if (typeof value === "boolean") setTargetLock(value);
      }),
      ctx.state.subscribe(STATE_KEYS.camX, (value) => {
        if (typeof value === "number") setCamX(value);
      }),
      ctx.state.subscribe(STATE_KEYS.camY, (value) => {
        if (typeof value === "number") setCamY(value);
      }),
      ctx.state.subscribe(STATE_KEYS.camZ, (value) => {
        if (typeof value === "number") setCamZ(value);
      }),
      ctx.state.subscribe(STATE_KEYS.fov, (value) => {
        if (typeof value === "number") setFov(value);
      }),
      ctx.state.subscribe(STATE_KEYS.intensity, (value) => {
        if (typeof value === "number") setIntensity(value);
      }),
      ctx.state.subscribe(STATE_KEYS.color, (value) => {
        if (typeof value === "string") setColor(value);
      }),
      ctx.state.subscribe(STATE_KEYS.backgroundBlur, (value) => {
        if (typeof value === "number") setBackgroundBlur(value);
      }),
      ctx.state.subscribe(STATE_KEYS.foregroundBlur, (value) => {
        if (typeof value === "number") setForegroundBlur(value);
      }),
      ctx.state.subscribe(STATE_KEYS.backgroundSrc, (value) => {
        if (typeof value === "string") setBackgroundSrc(value);
      }),
      ctx.state.subscribe(STATE_KEYS.foregroundSrc, (value) => {
        if (typeof value === "string") setForegroundSrc(value);
      }),
      ctx.state.subscribe(STATE_KEYS.backgroundMediaType, (value) => {
        if (value === "image" || value === "video" || value === null) {
          setBackgroundMediaType(value);
        }
      }),
      ctx.state.subscribe(STATE_KEYS.foregroundMediaType, (value) => {
        if (value === "image" || value === "video" || value === null) {
          setForegroundMediaType(value);
        }
      }),
      ctx.state.subscribe(STATE_KEYS.backgroundName, (value) => {
        if (typeof value === "string") setBackgroundName(value);
      }),
      ctx.state.subscribe(STATE_KEYS.foregroundName, (value) => {
        if (typeof value === "string") setForegroundName(value);
      }),
    ];

    return () => {
      for (const sub of subs) sub.dispose();
    };
  }, [ctx]);

  useEffect(() => {
    ctx.state.set(STATE_KEYS.tracking, tracking);
    ctx.state.set(STATE_KEYS.targetLock, targetLock);
    ctx.state.set(STATE_KEYS.camX, camX);
    ctx.state.set(STATE_KEYS.camY, camY);
    ctx.state.set(STATE_KEYS.camZ, camZ);
    ctx.state.set(STATE_KEYS.fov, fov);
    ctx.state.set(STATE_KEYS.intensity, intensity);
    ctx.state.set(STATE_KEYS.color, color);
    ctx.state.set(STATE_KEYS.backgroundBlur, backgroundBlur);
    ctx.state.set(STATE_KEYS.foregroundBlur, foregroundBlur);
    ctx.state.set(STATE_KEYS.backgroundSrc, backgroundSrc);
    ctx.state.set(STATE_KEYS.foregroundSrc, foregroundSrc);
    ctx.state.set(STATE_KEYS.backgroundMediaType, backgroundMediaType);
    ctx.state.set(STATE_KEYS.foregroundMediaType, foregroundMediaType);
    ctx.state.set(STATE_KEYS.backgroundName, backgroundName);
    ctx.state.set(STATE_KEYS.foregroundName, foregroundName);
  }, [
    tracking,
    targetLock,
    camX,
    camY,
    camZ,
    fov,
    intensity,
    color,
    backgroundBlur,
    foregroundBlur,
    backgroundSrc,
    foregroundSrc,
    backgroundMediaType,
    foregroundMediaType,
    backgroundName,
    foregroundName,
    ctx,
  ]);

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
      if (targetLock) {
        ctx.three.camera.lookAt(DEFAULT_TARGET_X, camY, DEFAULT_TARGET_Z);
      }
    }
  }, [tracking, targetLock, camX, camY, camZ, ctx]);

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

  useEffect(() => {
    ctx.scene.updateLayer({ role: "background" }, { blur: backgroundBlur });
  }, [backgroundBlur, ctx]);

  useEffect(() => {
    ctx.scene.updateLayer({ role: "foreground" }, { blur: foregroundBlur });
  }, [foregroundBlur, ctx]);

  useEffect(() => {
    if (backgroundSrc === "" || backgroundMediaType === null) return;
    ctx.scene.updateLayer(
      { role: "background" },
      { src: backgroundSrc, mediaType: backgroundMediaType },
    );
  }, [backgroundSrc, backgroundMediaType, ctx]);

  useEffect(() => {
    if (foregroundSrc === "" || foregroundMediaType === null) return;
    ctx.scene.updateLayer(
      { role: "foreground" },
      { src: foregroundSrc, mediaType: foregroundMediaType },
    );
  }, [foregroundSrc, foregroundMediaType, ctx]);

  useEffect(() => {
    backgroundSrcRef.current = backgroundSrc;
  }, [backgroundSrc]);

  useEffect(() => {
    foregroundSrcRef.current = foregroundSrc;
  }, [foregroundSrc]);

  useEffect(() => {
    return () => {
      const background = backgroundSrcRef.current;
      const foreground = foregroundSrcRef.current;
      revokeObjectUrl(background);
      revokeObjectUrl(foreground);
      clearVolatileMediaState(
        ctx,
        STATE_KEYS.backgroundSrc,
        STATE_KEYS.backgroundMediaType,
        STATE_KEYS.backgroundName,
        background,
      );
      clearVolatileMediaState(
        ctx,
        STATE_KEYS.foregroundSrc,
        STATE_KEYS.foregroundMediaType,
        STATE_KEYS.foregroundName,
        foreground,
      );
    };
  }, [ctx]);

  const setLayerMedia = (role: "background" | "foreground", file: File) => {
    const url = URL.createObjectURL(file);
    const mediaType = fileMediaType(file);
    if (role === "background") {
      revokeObjectUrl(backgroundSrc);
      setBackgroundSrc(url);
      setBackgroundMediaType(mediaType);
      setBackgroundName(file.name);
    } else {
      revokeObjectUrl(foregroundSrc);
      setForegroundSrc(url);
      setForegroundMediaType(mediaType);
      setForegroundName(file.name);
    }
    ctx.scene.updateLayer({ role }, { src: url, mediaType });
  };

  const clearLayerMedia = (role: "background" | "foreground") => {
    if (role === "background") {
      revokeObjectUrl(backgroundSrc);
      setBackgroundSrc("");
      setBackgroundMediaType(null);
      setBackgroundName("");
      if (backgroundInputRef.current) backgroundInputRef.current.value = "";
    } else {
      revokeObjectUrl(foregroundSrc);
      setForegroundSrc("");
      setForegroundMediaType(null);
      setForegroundName("");
      if (foregroundInputRef.current) foregroundInputRef.current.value = "";
    }
    ctx.scene.resetLayer({ role });
    ctx.scene.updateLayer(
      { role },
      { blur: role === "background" ? backgroundBlur : foregroundBlur },
    );
  };

  const onMediaChange =
    (role: "background" | "foreground") => (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (file) setLayerMedia(role, file);
    };

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

  const buttonRowStyle: React.CSSProperties = {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: "8px",
  };

  const buttonStyle: React.CSSProperties = {
    border: "1px solid rgba(236, 239, 244, 0.22)",
    borderRadius: "6px",
    background: "rgba(236, 239, 244, 0.08)",
    color: "#eceff4",
    font: "inherit",
    padding: "6px 8px",
    cursor: "pointer",
  };

  const fileNameStyle: React.CSSProperties = {
    minHeight: "1.4em",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    opacity: 0.82,
  };

  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: "var(--sidebar-width)",
        width: "calc(100% - var(--sidebar-width))",
        height: PANEL_HEIGHT,
        padding: "12px",
        display: "grid",
        gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
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
          <input
            type="checkbox"
            checked={targetLock}
            disabled={tracking}
            onChange={(e) => setTargetLock(e.target.checked)}
          />{" "}
          Look at character
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
      <div style={panelStyle}>
        <strong>Scene</strong>
        <label>
          Background blur: {backgroundBlur.toFixed(0)}
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={backgroundBlur}
            style={rangeStyle}
            onChange={(e) => setBackgroundBlur(Number(e.target.value))}
          />
        </label>
        <div style={fileNameStyle}>{backgroundName || "Background media"}</div>
        <div style={buttonRowStyle}>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => backgroundInputRef.current?.click()}
          >
            Load
          </button>
          <button type="button" style={buttonStyle} onClick={() => clearLayerMedia("background")}>
            Clear
          </button>
        </div>
        <input
          ref={backgroundInputRef}
          type="file"
          accept="image/*,video/*"
          style={{ display: "none" }}
          onChange={onMediaChange("background")}
        />
        <label>
          Foreground blur: {foregroundBlur.toFixed(0)}
          <input
            type="range"
            min={0}
            max={24}
            step={1}
            value={foregroundBlur}
            style={rangeStyle}
            onChange={(e) => setForegroundBlur(Number(e.target.value))}
          />
        </label>
        <div style={fileNameStyle}>{foregroundName || "Foreground media"}</div>
        <div style={buttonRowStyle}>
          <button
            type="button"
            style={buttonStyle}
            onClick={() => foregroundInputRef.current?.click()}
          >
            Load
          </button>
          <button type="button" style={buttonStyle} onClick={() => clearLayerMedia("foreground")}>
            Clear
          </button>
        </div>
        <input
          ref={foregroundInputRef}
          type="file"
          accept="image/*,video/*"
          style={{ display: "none" }}
          onChange={onMediaChange("foreground")}
        />
      </div>
    </div>
  );
}

export default {
  id: "camera-lighting-panel",
  type: "ui",
  layout: {
    terminal: {
      position: {
        top: PANEL_HEIGHT,
        left: "var(--sidebar-width)",
        width: "calc(100% - var(--sidebar-width))",
        height: `calc(100% - ${PANEL_HEIGHT})`,
      },
    },
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
