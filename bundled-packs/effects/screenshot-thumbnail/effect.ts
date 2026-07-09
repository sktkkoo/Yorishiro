/**
 * screenshot-thumbnail — 撮影済み screenshot を右下サムネイルとして表示する
 * built-in Effect Pack。
 *
 * 主用途: MCP screenshot 撮影時に「何が撮れたか」を user に伝えるための
 * 視覚フィードバック。撮影済み dataUrl をいったん画面全面に重ね、次フレームで
 * transform の translate + scale のみを使って右下へ縮小する。
 *
 * 実装は ctx.renderer.addDomLayer で全画面 img を貼る。DOM overlay なので
 * screenshot 自体には写らない（撮影 → dataUrl / PNG bytes 確定 → dispatch の
 * 順序になっている）。連続撮影時は module scope の current layer を即 dispose
 * して最新の screenshot に置換する。
 */

import type { Disposable, EffectContext, EffectDefinition } from "@yorishiro/sdk";

interface ScreenshotThumbnailOptions {
  /** 表示する screenshot の data URL。 */
  readonly dataUrl: string;
  /** 全面画像からサムネイルへ縮小する時間（ms）。default: 460 */
  readonly shrinkMs: number;
  /** サムネイル状態で保持する時間（ms）。default: 2600 */
  readonly holdMs: number;
  /** 退場 fade-out の時間（ms）。default: 360 */
  readonly fadeOutMs: number;
  /** サムネイルの目標幅（CSS px）。default: 180 */
  readonly thumbnailWidth: number;
  /** 右下からの余白（CSS px）。default: 22 */
  readonly margin: number;
  /** 縮小 transform の easing。default: cubic-bezier(0.22, 1, 0.36, 1) */
  readonly easing: string;
}

interface ActiveThumbnailLayer {
  readonly handle: Disposable;
  disposed: boolean;
}

interface TargetTransform {
  readonly transform: string;
  readonly scale: number;
}

interface ViewportBox {
  readonly width: number;
  readonly height: number;
}

interface ImageDimensions {
  readonly width: number;
  readonly height: number;
}

interface ImageBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

let currentLayer: ActiveThumbnailLayer | null = null;

const CARD_BORDER_RADIUS_PX = 10;
const CARD_BORDER_WIDTH_PX = 1;
const CARD_SHADOW_Y_PX = 14;
const CARD_SHADOW_BLUR_PX = 34;

function disposeLayer(layer: ActiveThumbnailLayer): void {
  if (layer.disposed) return;
  layer.disposed = true;
  layer.handle.dispose();
}

function disposeCurrentLayer(): void {
  if (!currentLayer) return;
  const layer = currentLayer;
  currentLayer = null;
  disposeLayer(layer);
}

function clampPositive(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(1, value);
}

function resolveViewportBox(container: HTMLDivElement): ViewportBox {
  const rect = container.getBoundingClientRect();
  return {
    width: Math.max(1, rect.width || window.innerWidth || 1),
    height: Math.max(1, rect.height || window.innerHeight || 1),
  };
}

function resolveContainImageBox(viewport: ViewportBox, image: ImageDimensions | null): ImageBox {
  if (!image) {
    return { left: 0, top: 0, width: viewport.width, height: viewport.height };
  }

  const fitScale = Math.min(viewport.width / image.width, viewport.height / image.height);
  const width = image.width * fitScale;
  const height = image.height * fitScale;
  return {
    left: (viewport.width - width) / 2,
    top: (viewport.height - height) / 2,
    width,
    height,
  };
}

function applyImageBox(img: HTMLImageElement, box: ImageBox): void {
  img.style.left = `${box.left}px`;
  img.style.top = `${box.top}px`;
  img.style.width = `${box.width}px`;
  img.style.height = `${box.height}px`;
}

function readNaturalDimensions(img: HTMLImageElement): ImageDimensions | null {
  const width = img.naturalWidth;
  const height = img.naturalHeight;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}

async function waitForNaturalDimensions(img: HTMLImageElement): Promise<ImageDimensions | null> {
  if (typeof img.decode === "function") {
    try {
      await img.decode();
    } catch {
      return readNaturalDimensions(img);
    }
    return readNaturalDimensions(img);
  }

  const alreadyAvailable = readNaturalDimensions(img);
  if (alreadyAvailable || img.complete) return alreadyAvailable;
  if (typeof img.addEventListener !== "function") return null;

  await new Promise<void>((resolve) => {
    const done = () => {
      img.removeEventListener("load", done);
      img.removeEventListener("error", done);
      resolve();
    };
    img.addEventListener("load", done, { once: true });
    img.addEventListener("error", done, { once: true });
  });

  return readNaturalDimensions(img);
}

function resolveTargetTransform(
  viewport: ViewportBox,
  imageBox: ImageBox,
  thumbnailWidth: number,
  margin: number,
): TargetTransform {
  const safeMargin = Math.max(0, margin);
  const targetWidth = Math.max(1, Math.min(thumbnailWidth, viewport.width - safeMargin * 2));
  const scale = targetWidth / imageBox.width;
  const targetHeight = imageBox.height * scale;
  const targetLeft = viewport.width - safeMargin - targetWidth;
  const targetTop = viewport.height - safeMargin - targetHeight;
  const translateX = targetLeft - imageBox.left;
  const translateY = targetTop - imageBox.top;
  return { transform: `translate(${translateX}px, ${translateY}px) scale(${scale})`, scale };
}

function compensateScaledPx(finalPx: number, scale: number): string {
  return `${finalPx / Math.max(0.001, scale)}px`;
}

export default {
  id: "screenshot-thumbnail",
  type: "effect",
  run: async (
    ctx: EffectContext<Partial<ScreenshotThumbnailOptions>>,
    options: Partial<ScreenshotThumbnailOptions>,
  ): Promise<void> => {
    if (typeof options.dataUrl !== "string" || options.dataUrl === "") return;

    const shrinkMs = clampPositive(options.shrinkMs, 460);
    const holdMs = Math.max(0, options.holdMs ?? 2600);
    const fadeOutMs = clampPositive(options.fadeOutMs, 360);
    const thumbnailWidth = clampPositive(options.thumbnailWidth, 180);
    const margin = Math.max(0, options.margin ?? 22);
    const easing = options.easing ?? "cubic-bezier(0.22, 1, 0.36, 1)";

    disposeCurrentLayer();

    let overlay: HTMLImageElement | null = null;
    let layerContainer: HTMLDivElement | null = null;
    let targetTransform: TargetTransform = { transform: "translate(0px, 0px) scale(1)", scale: 1 };
    const handle = ctx.renderer.addDomLayer((container) => {
      const img = document.createElement("img");
      img.src = options.dataUrl ?? "";
      img.alt = "";
      img.style.position = "absolute";
      img.style.display = "block";
      img.style.visibility = "hidden";
      img.style.pointerEvents = "none";
      img.style.transformOrigin = "top left";
      img.style.transform = "translate(0px, 0px) scale(1)";
      img.style.opacity = "1";
      img.style.borderRadius = "0";
      img.style.border = "0 solid transparent";
      img.style.boxSizing = "border-box";
      img.style.boxShadow = "0 0 0 rgba(0, 0, 0, 0)";
      img.style.willChange = "transform, opacity, border-radius, box-shadow";
      img.style.transition = [
        `transform ${shrinkMs}ms ${easing}`,
        `border-radius ${shrinkMs}ms ${easing}`,
        `border-width ${shrinkMs}ms ${easing}`,
        `box-shadow ${shrinkMs}ms ${easing}`,
        `border-color ${shrinkMs}ms ${easing}`,
      ].join(", ");
      container.appendChild(img);
      overlay = img;
      layerContainer = container;
    });
    const activeLayer: ActiveThumbnailLayer = { handle, disposed: false };
    currentLayer = activeLayer;

    try {
      if (overlay && layerContainer) {
        const el = overlay as HTMLImageElement;
        const dimensions = await waitForNaturalDimensions(el);
        if (activeLayer.disposed) return;
        const viewport = resolveViewportBox(layerContainer);
        const imageBox = resolveContainImageBox(viewport, dimensions);
        applyImageBox(el, imageBox);
        targetTransform = resolveTargetTransform(viewport, imageBox, thumbnailWidth, margin);
        el.style.visibility = "visible";
      }

      // 次フレームで transform を入れて、全面画像から右下サムネイルへ縮小する。
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      if (overlay) {
        const el = overlay as HTMLImageElement;
        // カード装飾の長さは「縮小後に見える CSS px」として扱い、scale 分を逆補正する。
        const borderRadius = compensateScaledPx(CARD_BORDER_RADIUS_PX, targetTransform.scale);
        const borderWidth = compensateScaledPx(CARD_BORDER_WIDTH_PX, targetTransform.scale);
        const shadowY = compensateScaledPx(CARD_SHADOW_Y_PX, targetTransform.scale);
        const shadowBlur = compensateScaledPx(CARD_SHADOW_BLUR_PX, targetTransform.scale);
        el.style.transform = targetTransform.transform;
        el.style.borderRadius = borderRadius;
        el.style.borderWidth = borderWidth;
        el.style.borderColor = "rgba(255, 255, 255, 0.42)";
        el.style.boxShadow = `0 ${shadowY} ${shadowBlur} rgba(0, 0, 0, 0.28)`;
      }
      await ctx.time.after(shrinkMs);
      await ctx.time.after(holdMs);

      if (overlay) {
        const el = overlay as HTMLImageElement;
        el.style.transition = `opacity ${fadeOutMs}ms ease-out`;
        el.style.opacity = "0";
      }
      await ctx.time.after(fadeOutMs);
    } finally {
      if (currentLayer === activeLayer) {
        currentLayer = null;
      }
      disposeLayer(activeLayer);
    }
  },
} satisfies EffectDefinition<ScreenshotThumbnailOptions>;
