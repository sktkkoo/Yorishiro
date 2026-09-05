import { Environment, Lightformer, useGLTF } from "@react-three/drei";
import type { ScenePackComponentProps, ScenePackDefinition } from "@yorishiro/sdk";
import { useControlsBridge, useYorishiroControls } from "@yorishiro/sdk/controls";
import { Suspense, useEffect, useMemo } from "react";
import * as THREE from "three";
import { adaptCeramicMaterial, adaptFoliageMaterial } from "./lib/foliage-material";

const ID = "amber-window-room";

function Room({ url }: { url: string }) {
  // テクスチャ内包・非圧縮のGLBなので、外部デコーダーは不要。
  const { scene } = useGLTF(url, false, false);
  const { object, ownedMaterials } = useMemo(() => {
    const object = scene.clone(true);
    const materials = new Map<THREE.Material, THREE.Material>();
    function localMaterial(source: THREE.Material): THREE.Material {
      const existing = materials.get(source);
      if (existing) return existing;
      let material: THREE.Material;
      if (
        source.name.startsWith("Exterior | generated courtyard") &&
        source instanceof THREE.MeshStandardMaterial
      ) {
        // 窓外画像は自身の明暗を持つ背景。共有キャッシュを変更せず、
        // 複製した材質だけを照明の影響を受けない表示に変える。
        material = new THREE.MeshBasicMaterial({
          name: source.name,
          map: source.emissiveMap ?? source.map,
          color: source.emissive.clone(),
          side: source.side,
          toneMapped: false,
        });
      } else {
        material = adaptFoliageMaterial(source) ?? adaptCeramicMaterial(source) ?? source.clone();
      }
      materials.set(source, material);
      return material;
    }
    object.traverse((child) => {
      if (!(child instanceof THREE.Mesh)) return;
      child.material = Array.isArray(child.material)
        ? child.material.map(localMaterial)
        : localMaterial(child.material);
      // シャドウマップが無効な環境でも接触AOで局所的な陰影を保持する。
      child.castShadow = true;
      child.receiveShadow = true;
    });
    return { object, ownedMaterials: [...materials.values()] };
  }, [scene]);

  useEffect(
    () => () => {
      for (const material of ownedMaterials) material.dispose();
    },
    [ownedMaterials],
  );

  // ジオメトリとテクスチャはDreiの共有キャッシュが所有する。
  return <primitive object={object} dispose={null} />;
}

function RoomLights() {
  const [controls, setControls] = useYorishiroControls("lights", () => ({
    ambientIntensity: { value: 0.45, min: 0, max: 2, step: 0.01, label: "ambient" },
    ambientColor: { value: "#c4ccc1", label: "ambient color" },
    windowIntensity: { value: 1.15, min: 0, max: 4, step: 0.01, label: "window" },
    windowColor: { value: "#ffd39a", label: "window color" },
    lampIntensity: { value: 1.3, min: 0, max: 5, step: 0.01, label: "paper lamps" },
    lampColor: { value: "#ffb35b", label: "lamp color" },
    fillIntensity: { value: 0.5, min: 0, max: 2, step: 0.01, label: "resident fill" },
  }));
  useControlsBridge(ID, controls, setControls);

  const windowTarget = useMemo(() => {
    const target = new THREE.Object3D();
    target.position.set(-0.2, 0.8, -0.35);
    return target;
  }, []);
  const residentTarget = useMemo(() => {
    const target = new THREE.Object3D();
    target.position.set(0, 1.2, 0);
    return target;
  }, []);

  return (
    <>
      <primitive object={windowTarget} />
      <primitive object={residentTarget} />
      <ambientLight
        intensity={Number(controls.ambientIntensity)}
        color={String(controls.ambientColor)}
      />
      <directionalLight
        position={[0.7, 2.44, -1.95]}
        target={windowTarget}
        intensity={Number(controls.windowIntensity)}
        color={String(controls.windowColor)}
      />
      <pointLight
        position={[-1.06, 1.46, -1.83]}
        intensity={Number(controls.lampIntensity)}
        color={String(controls.lampColor)}
        distance={4}
        decay={2}
      />
      <pointLight
        position={[-1.05, 2.43, -1.91]}
        intensity={Number(controls.lampIntensity) * 0.25}
        color={String(controls.lampColor)}
        distance={3}
        decay={2}
      />
      <directionalLight
        position={[-0.4, 2.2, 1.5]}
        target={residentTarget}
        intensity={Number(controls.fillIntensity)}
        color="#eadfca"
      />
    </>
  );
}

function TwilightCafe({ resolveAsset, vrmSlot }: ScenePackComponentProps) {
  const [placement, setPlacement] = useYorishiroControls("room", () => ({
    distance: { value: 1.6, min: 0, max: 5, step: 0.05, label: "room distance" },
  }));
  useControlsBridge(ID, placement, setPlacement);

  return (
    <>
      <Environment frames={1} resolution={64} background={false} environmentIntensity={0.18}>
        <Lightformer position={[0.7, 2, -3]} scale={[2.4, 1.5, 1]} color="#fff0d2" intensity={3} />
        <Lightformer
          position={[-2, 1.8, 1.3]}
          rotation={[0, Math.PI / 2, 0]}
          scale={[1.2, 1.6, 1]}
          color="#b3c6bf"
          intensity={0.6}
        />
      </Environment>
      <group position={[0, 0, -Number(placement.distance)]}>
        <RoomLights />
        <Suspense fallback={null}>
          <Room url={resolveAsset("./assets/room-polished.glb")} />
        </Suspense>
      </group>
      {vrmSlot}
    </>
  );
}

export default {
  id: ID,
  type: "scene",
  scene: {
    id: ID,
    layers: [
      { id: "room-backdrop", role: "background", backgroundColor: "#171b16" },
      { id: "vrm-slot", role: "character", blur: 0 },
      {
        id: "soft-vignette",
        role: "foreground",
        backgroundImage:
          "radial-gradient(ellipse at 50% 50%, transparent 62%, rgba(12, 14, 10, 0.22) 100%)",
      },
    ],
    ambient: [],
    terminal: {
      // シーン切替後もCLIが明るい入力欄を保持するため、紙色の背景と
      // 濃い文字を組み合わせ、既存の入力・返信を読める状態に保つ。
      background: "#e7e7d9",
      foreground: "#2c352c",
      cursor: "#775d29",
      cursorAccent: "#f3f0df",
      selectionBackground: "#bdc9af",
      selectionForeground: "#202a21",
      black: "#202922",
      red: "#9f4739",
      green: "#476139",
      yellow: "#82601f",
      blue: "#3e626d",
      magenta: "#74556c",
      cyan: "#35695b",
      white: "#454b40",
      brightBlack: "#69705f",
      brightRed: "#aa4836",
      brightGreen: "#416531",
      brightYellow: "#7d5c17",
      brightBlue: "#345f70",
      brightMagenta: "#765070",
      brightCyan: "#286855",
      brightWhite: "#202922",
    },
    ui: {
      background: "#171b16",
      foreground: "#ddd6be",
      foregroundDim: "rgba(221, 214, 190, 0.58)",
      sidebarBackground: "#121610",
      panelBackground: "rgba(23, 27, 22, 0.96)",
      border: "rgba(148, 160, 122, 0.25)",
      buttonBackground: "#293127",
      buttonForeground: "#ddd6be",
      inputBackground: "rgba(221, 214, 190, 0.04)",
      accent: "#d6ae70",
      accentSoft: "rgba(214, 174, 112, 0.08)",
      accentBorder: "rgba(214, 174, 112, 0.27)",
      muted: "#67715d",
      glow: "rgba(214, 174, 112, 0.05)",
    },
  },
  component: TwilightCafe,
} satisfies ScenePackDefinition;
