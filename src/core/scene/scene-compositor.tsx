// src/core/scene/scene-compositor.tsx

import { type CSSProperties, type ReactNode, useState } from "react";
import { ProceduralSceneLayer } from "./procedural-scene-layer";
import type { Layer, SceneSpec } from "./types";

/**
 * Scene Compositor — layer stack を DOM で描画する薄い component。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「UI は環境である」
 * Internal design-record: specs/2026-04-18-scene-pack-compositor-design.md §5
 *
 * 責務:
 *   - scene.layers を stacking order で <div> として描画。scene.layers の**先頭が一番奥**、
 *     末尾が一番手前。各 layer は `position: absolute; inset: 0` で親を覆い、後続 sibling が
 *     DOM 順で上に重なる。
 *   - role="foreground" は前景の意味を優先し、ThreeRuntime が body 直下に置く character
 *     canvas より前に来るよう positive z-index を持つ。
 *   - per-layer の blur / backgroundColor / backgroundImage を inline style で apply
 *   - layer.src が set されていれば <img> or <video> を挿入（拡張子から判定）
 *   - role="character" の layer に children を埋める（= VRM の slot）
 *
 * 非責務:
 *   - VRM の生成 / lifecycle（ThreeRuntime singleton が所有）
 *   - pack の load / manifest parse（Phase 2）
 *   - ambient binding の評価（Phase 3）
 *   - asset の load state / error handling（本 MVP は放置、必要なら Phase 2 で拾う）
 */
export interface SceneCompositorProps {
  readonly scene: SceneSpec;
  /** character role layer に差し込まれる slot content (= VrmViewer 等) */
  readonly children?: ReactNode;
}

const containerStyle: CSSProperties = {
  position: "relative",
  width: "100%",
  height: "100%",
  overflow: "hidden",
};

const layerBaseStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
};

const foregroundLayerZIndex = 1;

/**
 * media（img / video）の base style。
 *
 * 要素自体を「cover サイズ」（短辺が viewport にピッタリ、長辺は viewport を超える native 比率）
 * に広げて中央配置する。object-fit:cover とは違い、要素そのものが viewport の外まで実体として
 * 存在するため、transform で pan / scale すると画面外にあった部分が入ってくる。はみ出した分は
 * 親 (.scene-compositor / .charactor-container) の overflow:hidden でクリップされ、ターミナル等
 * カメラ外には描画されない。
 *
 * 寸法は container query 単位で算出する（layer div に container-type:size を付ける）。
 * --media-aspect（= naturalWidth / naturalHeight）は読み込み時に SceneMedia が set する。
 * cover: scaledW = max(Cw, Ch * aspect), scaledH = max(Ch, Cw / aspect)。
 */
const mediaBaseStyle: CSSProperties = {
  position: "absolute",
  left: "50%",
  top: "50%",
  width: "max(100cqw, calc(100cqh * var(--media-aspect, 1)))",
  height: "max(100cqh, calc(100cqw / var(--media-aspect, 1)))",
  objectFit: "cover",
  display: "block",
};

/**
 * 動画拡張子かを判定する pure 関数。
 * .webm / .mp4 / .mov / .m4v / .ogv を動画とみなす（case-insensitive）。
 * query string は reject（regex が $ でアンカーするため）。
 */
export function isVideoSrc(src: string): boolean {
  return /^data:video\//i.test(src) || /\.(webm|mp4|mov|m4v|ogv)$/i.test(src);
}

export function isVideoLayer(layer: Layer): boolean {
  if (layer.mediaType !== undefined) return layer.mediaType === "video";
  return layer.src !== undefined && isVideoSrc(layer.src);
}

export function isProceduralLayer(layer: Layer): boolean {
  return layer.procedural !== undefined;
}

/**
 * Layer -> inline style の pure 関数。test 対象。
 * export しておき scene-compositor.test.ts から import する。
 */
export function layerStyle(layer: Layer): CSSProperties {
  const style: CSSProperties = { ...layerBaseStyle };
  if (layer.role === "foreground") {
    style.zIndex = foregroundLayerZIndex;
  }
  const filters: string[] = [];
  if (typeof layer.blur === "number") {
    filters.push(`blur(${layer.blur}px)`);
  }
  if (layer.dropShadow !== undefined) {
    const shadow = layer.dropShadow;
    filters.push(
      `drop-shadow(${shadow.offsetX}px ${shadow.offsetY}px ${shadow.blur}px ${shadow.color})`,
    );
  }
  if (filters.length > 0) {
    style.filter = filters.join(" ");
  }
  if (typeof layer.opacity === "number") {
    style.opacity = layer.opacity;
  }
  if (layer.backgroundColor !== undefined) {
    style.backgroundColor = layer.backgroundColor;
  }
  if (layer.backgroundImage !== undefined) {
    style.backgroundImage = layer.backgroundImage;
  }
  // media layer は container query の基準にする（cover サイズ算出のため）。
  // size containment は paint を clip しないので、はみ出しは親の overflow が握る。
  if (layer.src !== undefined) {
    style.containerType = "size";
  }
  return style;
}

/**
 * media（img / video）要素の inline style を作る pure 関数。test 対象。
 *
 * mediaBaseStyle（cover サイズ + 中央配置）をベースに、中央寄せの translate(-50%,-50%) と
 * layer の offset/scale/rotation を 1 本の transform に合成する。offset が無くても中央寄せの
 * transform は常に付く（要素を viewport 中央に置くため）。
 */
export function mediaStyle(layer: Layer): CSSProperties {
  const transforms: string[] = ["translate(-50%, -50%)"];
  const { mediaOffsetX, mediaOffsetY } = layer;
  if (typeof mediaOffsetX === "number" || typeof mediaOffsetY === "number") {
    transforms.push(`translate(${mediaOffsetX ?? 0}%, ${mediaOffsetY ?? 0}%)`);
  }
  if (typeof layer.mediaScale === "number") {
    transforms.push(`scale(${layer.mediaScale})`);
  }
  if (typeof layer.mediaRotation === "number") {
    transforms.push(`rotate(${layer.mediaRotation}deg)`);
  }
  return { ...mediaBaseStyle, transform: transforms.join(" ") };
}

/**
 * style に --media-aspect を載せて返す。aspect 未確定（読み込み前）は
 * mediaBaseStyle 側の fallback 1 が効くので付けない。
 */
function withAspect(style: CSSProperties, aspect: number | null): CSSProperties {
  if (aspect === null) return style;
  return { ...style, ["--media-aspect" as string]: aspect } as CSSProperties;
}

/**
 * media 要素。読み込み時に naturalWidth/Height（video は videoWidth/Height）から
 * 縦横比を測り、--media-aspect として style に載せる。これで cover サイズが確定し、
 * 要素が viewport の外まで広がる（はみ出しは親の overflow:hidden が clip）。
 */
function SceneMedia({ layer }: { layer: Layer }) {
  const [aspect, setAspect] = useState<number | null>(null);
  const style = withAspect(mediaStyle(layer), aspect);

  if (isVideoLayer(layer)) {
    return (
      <video
        src={layer.src}
        autoPlay
        muted
        loop
        playsInline
        style={style}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          if (v.videoWidth > 0 && v.videoHeight > 0) setAspect(v.videoWidth / v.videoHeight);
        }}
      />
    );
  }
  return (
    <img
      src={layer.src}
      alt=""
      style={style}
      onLoad={(e) => {
        const img = e.currentTarget;
        if (img.naturalWidth > 0 && img.naturalHeight > 0)
          setAspect(img.naturalWidth / img.naturalHeight);
      }}
    />
  );
}

export function SceneCompositor({ scene, children }: SceneCompositorProps) {
  return (
    <div className="scene-compositor" style={containerStyle}>
      {scene.layers.map((layer) => (
        <div key={layer.id} data-layer-id={layer.id} style={layerStyle(layer)}>
          {layer.procedural !== undefined ? (
            <ProceduralSceneLayer procedural={layer.procedural} />
          ) : null}
          {layer.src !== undefined ? <SceneMedia layer={layer} /> : null}
          {layer.role === "character" ? children : null}
        </div>
      ))}
    </div>
  );
}
