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
import { getSceneRegistry, type ScenePackEntry } from "../../runtime/scene-pack-registry";
import { getSceneLayerBridge } from "../scene/scene-layer-bridge";

export interface SceneLayerControlsProps {
  readonly store?: LevaStore;
}

const NO_MEDIA = "(none)";

type MediaLayerRole = "background" | "foreground";
const MEDIA_LAYER_ROLES = ["background", "foreground"] as const;

export function SceneLayerControls({ store }: SceneLayerControlsProps) {
  const [entry, setEntry] = useState<ScenePackEntry | null>(null);

  useEffect(() => {
    const sub = getSceneRegistry().subscribeActiveEntry(setEntry);
    return () => sub.dispose();
  }, []);

  if (!entry) return null;
  const roles = MEDIA_LAYER_ROLES.filter((role) =>
    entry.scene.layers?.some((layer) => layer.role === role && !layer.procedural),
  );
  return (
    <>
      {roles.map((role) => (
        <MediaLayerControls key={`${entry.id}:${role}`} store={store} role={role} />
      ))}
    </>
  );
}

function MediaLayerControls({
  store,
  role,
}: SceneLayerControlsProps & { readonly role: MediaLayerRole }) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const urlRef = useRef("");
  const setRef = useRef<(values: Record<string, unknown>) => void>(() => {});
  const label = role === "background" ? "bg" : "fg";
  const fileKey = `${role}File`;

  const [, set] = useControls(
    () => ({
      "scene layers": folder({
        [`${role}Blur`]: numberControl(`${label} blur`, 0, 0, 24, 1, role, "blur"),
        [`${role}Opacity`]: numberControl(`${label} opacity`, 1, 0, 1, 0.01, role, "opacity"),
        [`${role}OffsetX`]: numberControl(`${label} pos x`, 0, -100, 100, 1, role, "mediaOffsetX"),
        [`${role}OffsetY`]: numberControl(`${label} pos y`, 0, -100, 100, 1, role, "mediaOffsetY"),
        [`${role}Scale`]: numberControl(`${label} scale`, 1, 0.1, 3, 0.01, role, "mediaScale"),
        [`${role}Rotation`]: numberControl(
          `${label} rotate`,
          0,
          -180,
          180,
          1,
          role,
          "mediaRotation",
        ),
        [fileKey]: { value: NO_MEDIA, editable: false, label: role },
        [`load ${label}`]: button(() => inputRef.current?.click()),
        [`clear ${label}`]: button(() => {
          revokeUrl(urlRef.current);
          urlRef.current = "";
          getSceneLayerBridge()?.resetLayer({ role });
          if (inputRef.current) inputRef.current.value = "";
          setRef.current(resetValues(role));
        }),
      }),
    }),
    { store },
  );

  setRef.current = set as (values: Record<string, unknown>) => void;

  useEffect(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*,video/*";
    input.style.display = "none";
    const onChange = () => {
      const file = input.files?.[0];
      if (!file) return;
      revokeUrl(urlRef.current);
      const url = URL.createObjectURL(file);
      urlRef.current = url;
      const mediaType = file.type.startsWith("video/") ? "video" : "image";
      getSceneLayerBridge()?.updateLayer({ role }, { src: url, mediaType });
      // leva の string control は schema の初期値を読み直さないため、set() で更新する。
      setRef.current({ [fileKey]: file.name });
    };
    input.addEventListener("change", onChange);
    document.body.appendChild(input);
    inputRef.current = input;
    setRef.current({ [fileKey]: NO_MEDIA });
    return () => {
      // role の削除・シーン切替・StrictMode の再実行で古い input を再利用しない。
      input.removeEventListener("change", onChange);
      input.remove();
      inputRef.current = null;
      revokeUrl(urlRef.current);
      urlRef.current = "";
    };
  }, [role, fileKey]);

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
  role: MediaLayerRole,
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
function resetValues(role: MediaLayerRole): Record<string, unknown> {
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
