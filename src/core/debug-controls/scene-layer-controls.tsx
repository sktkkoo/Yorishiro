/**
 * Scene layer debug controls (leva).
 *
 * Active scene に DOM layers がある場合のみ表示される。
 * background / foreground の blur / opacity / media transform（位置・拡大縮小・回転）と
 * media (image/video) の読み込み・クリアを提供。
 */

import { button, folder, useControls } from "leva";
import { useEffect, useRef, useState } from "react";
import type { LevaStore } from "../../runtime/leva";
import { getSceneRegistry } from "../../runtime/scene-pack-registry";
import { getSceneLayerBridge } from "../scene/scene-layer-bridge";

export interface SceneLayerControlsProps {
  readonly store?: LevaStore;
}

const NO_MEDIA = "(none)";

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
  const backgroundUrlRef = useRef("");
  const foregroundUrlRef = useRef("");
  const setRef = useRef<(values: Record<string, unknown>) => void>(() => {});

  useEffect(() => {
    const makeInput = (
      urlRef: { current: string },
      role: "background" | "foreground",
      fileKey: string,
    ): HTMLInputElement => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*,video/*";
      input.style.display = "none";
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        if (!file) return;
        revokeUrl(urlRef.current);
        const url = URL.createObjectURL(file);
        urlRef.current = url;
        const mediaType = file.type.startsWith("video/") ? "video" : "image";
        getSceneLayerBridge()?.updateLayer({ role }, { src: url, mediaType });
        // leva の string control は schema の value を初期値としてしか読まないため、
        // 読み込んだファイル名を表示するには set() で明示的に push する必要がある。
        setRef.current({ [fileKey]: file.name });
      });
      document.body.appendChild(input);
      return input;
    };

    if (!backgroundInputRef.current) {
      backgroundInputRef.current = makeInput(backgroundUrlRef, "background", "backgroundFile");
    }
    if (!foregroundInputRef.current) {
      foregroundInputRef.current = makeInput(foregroundUrlRef, "foreground", "foregroundFile");
    }
    return () => {
      revokeUrl(backgroundUrlRef.current);
      revokeUrl(foregroundUrlRef.current);
      backgroundInputRef.current?.remove();
      foregroundInputRef.current?.remove();
    };
  }, []);

  const [, set] = useControls(
    () => ({
      "scene layers": folder({
        backgroundBlur: numberControl("bg blur", 0, 0, 24, 1, "background", "blur"),
        backgroundOpacity: numberControl("bg opacity", 1, 0, 1, 0.01, "background", "opacity"),
        backgroundOffsetX: numberControl("bg pos x", 0, -100, 100, 1, "background", "mediaOffsetX"),
        backgroundOffsetY: numberControl("bg pos y", 0, -100, 100, 1, "background", "mediaOffsetY"),
        backgroundScale: numberControl("bg scale", 1, 0.1, 3, 0.01, "background", "mediaScale"),
        backgroundRotation: numberControl(
          "bg rotate",
          0,
          -180,
          180,
          1,
          "background",
          "mediaRotation",
        ),
        backgroundFile: { value: NO_MEDIA, editable: false, label: "background media" },
        "load bg": button(() => backgroundInputRef.current?.click()),
        "clear bg": button(() => {
          revokeUrl(backgroundUrlRef.current);
          backgroundUrlRef.current = "";
          getSceneLayerBridge()?.resetLayer({ role: "background" });
          if (backgroundInputRef.current) backgroundInputRef.current.value = "";
          setRef.current(resetValues("background"));
        }),
        foregroundBlur: numberControl("fg blur", 0, 0, 24, 1, "foreground", "blur"),
        foregroundOpacity: numberControl("fg opacity", 1, 0, 1, 0.01, "foreground", "opacity"),
        foregroundOffsetX: numberControl("fg pos x", 0, -100, 100, 1, "foreground", "mediaOffsetX"),
        foregroundOffsetY: numberControl("fg pos y", 0, -100, 100, 1, "foreground", "mediaOffsetY"),
        foregroundScale: numberControl("fg scale", 1, 0.1, 3, 0.01, "foreground", "mediaScale"),
        foregroundRotation: numberControl(
          "fg rotate",
          0,
          -180,
          180,
          1,
          "foreground",
          "mediaRotation",
        ),
        foregroundFile: { value: NO_MEDIA, editable: false, label: "foreground media" },
        "load fg": button(() => foregroundInputRef.current?.click()),
        "clear fg": button(() => {
          revokeUrl(foregroundUrlRef.current);
          foregroundUrlRef.current = "";
          getSceneLayerBridge()?.resetLayer({ role: "foreground" });
          if (foregroundInputRef.current) foregroundInputRef.current.value = "";
          setRef.current(resetValues("foreground"));
        }),
      }),
    }),
    { store },
  );

  setRef.current = set as (values: Record<string, unknown>) => void;

  return null;
}

type LayerPatchKey =
  | "blur"
  | "opacity"
  | "mediaOffsetX"
  | "mediaOffsetY"
  | "mediaScale"
  | "mediaRotation";

/**
 * number control 定義の生成ヘルパ。onChange で対応する layer patch を bridge に流す。
 */
function numberControl(
  label: string,
  value: number,
  min: number,
  max: number,
  step: number,
  role: "background" | "foreground",
  patchKey: LayerPatchKey,
) {
  return {
    value,
    min,
    max,
    step,
    label,
    onChange: (v: number) => {
      getSceneLayerBridge()?.updateLayer({ role }, { [patchKey]: v });
    },
  };
}

/**
 * clear 時に panel のスライダを default へ戻す値セット。
 * file 表示と media transform を初期値に戻す（blur/opacity は既存挙動どおり据え置き）。
 */
function resetValues(role: "background" | "foreground"): Record<string, unknown> {
  return {
    [`${role}File`]: NO_MEDIA,
    [`${role}OffsetX`]: 0,
    [`${role}OffsetY`]: 0,
    [`${role}Scale`]: 1,
    [`${role}Rotation`]: 0,
  };
}

function revokeUrl(url: string): void {
  if (url.startsWith("blob:")) URL.revokeObjectURL(url);
}
