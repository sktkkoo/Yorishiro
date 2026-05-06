/**
 * Scene layer debug controls (leva).
 *
 * Active scene に DOM layers がある場合のみ表示される。
 * background / foreground の blur と media (image/video) の読み込み・クリアを提供。
 */

import { button, folder, useControls } from "leva";
import { useEffect, useRef, useState } from "react";
import { getSceneRegistry } from "../../runtime/scene-pack-registry";
import type { RuntimeLevaStore } from "../../runtime/three-runtime/runtime-leva-store";
import { getSceneLayerBridge } from "../scene/scene-layer-bridge";

export interface SceneLayerControlsProps {
  readonly store?: RuntimeLevaStore;
}

export function SceneLayerControls({ store }: SceneLayerControlsProps) {
  const [hasLayers, setHasLayers] = useState(false);

  useEffect(() => {
    const registry = getSceneRegistry();
    const sub = registry.subscribeActiveEntry((entry) => {
      const layers = entry?.scene.layers ?? [];
      const hasMediaLayers = layers.some(
        (l) => (l.role === "background" || l.role === "foreground") && !l.procedural,
      );
      setHasLayers(hasMediaLayers);
    });
    return () => sub.dispose();
  }, []);

  if (!hasLayers) return null;
  return <SceneLayerControlsInner store={store} />;
}

function SceneLayerControlsInner({ store }: SceneLayerControlsProps) {
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const foregroundInputRef = useRef<HTMLInputElement | null>(null);
  const [backgroundName, setBackgroundName] = useState("");
  const [foregroundName, setForegroundName] = useState("");
  const backgroundUrlRef = useRef("");
  const foregroundUrlRef = useRef("");

  useEffect(() => {
    if (!backgroundInputRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,video/*";
      input.style.display = "none";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;
        revokeUrl(backgroundUrlRef.current);
        const url = URL.createObjectURL(file);
        backgroundUrlRef.current = url;
        setBackgroundName(file.name);
        const mediaType = file.type.startsWith("video/") ? "video" : "image";
        getSceneLayerBridge()?.updateLayer({ role: "background" }, { src: url, mediaType });
      });
      document.body.appendChild(input);
      backgroundInputRef.current = input;
    }
    if (!foregroundInputRef.current) {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,video/*";
      input.style.display = "none";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;
        revokeUrl(foregroundUrlRef.current);
        const url = URL.createObjectURL(file);
        foregroundUrlRef.current = url;
        setForegroundName(file.name);
        const mediaType = file.type.startsWith("video/") ? "video" : "image";
        getSceneLayerBridge()?.updateLayer({ role: "foreground" }, { src: url, mediaType });
      });
      document.body.appendChild(input);
      foregroundInputRef.current = input;
    }
    return () => {
      revokeUrl(backgroundUrlRef.current);
      revokeUrl(foregroundUrlRef.current);
      backgroundInputRef.current?.remove();
      foregroundInputRef.current?.remove();
    };
  }, []);

  useControls(
    () => ({
      "scene layers": folder({
        backgroundBlur: {
          value: 0,
          min: 0,
          max: 24,
          step: 1,
          label: "bg blur",
          onChange: (v: number) => {
            getSceneLayerBridge()?.updateLayer({ role: "background" }, { blur: v });
          },
        },
        backgroundFile: {
          value: backgroundName || "(none)",
          editable: false,
          label: "bg media",
        },
        "load bg": button(() => backgroundInputRef.current?.click()),
        "clear bg": button(() => {
          revokeUrl(backgroundUrlRef.current);
          backgroundUrlRef.current = "";
          setBackgroundName("");
          getSceneLayerBridge()?.resetLayer({ role: "background" });
          if (backgroundInputRef.current) backgroundInputRef.current.value = "";
        }),
        foregroundBlur: {
          value: 0,
          min: 0,
          max: 24,
          step: 1,
          label: "fg blur",
          onChange: (v: number) => {
            getSceneLayerBridge()?.updateLayer({ role: "foreground" }, { blur: v });
          },
        },
        foregroundFile: {
          value: foregroundName || "(none)",
          editable: false,
          label: "fg media",
        },
        "load fg": button(() => foregroundInputRef.current?.click()),
        "clear fg": button(() => {
          revokeUrl(foregroundUrlRef.current);
          foregroundUrlRef.current = "";
          setForegroundName("");
          getSceneLayerBridge()?.resetLayer({ role: "foreground" });
          if (foregroundInputRef.current) foregroundInputRef.current.value = "";
        }),
      }),
    }),
    [backgroundName, foregroundName],
    { store },
  );

  return null;
}

function revokeUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
