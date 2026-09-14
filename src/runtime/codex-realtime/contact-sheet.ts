export interface ContactSheetSample {
  readonly dataUrl: string;
  readonly capturedAt: number;
}

// Native preview validation allows at most 2560px on either edge and 256 KiB.
const MAX_SHEET_SIZE = 2560;
const SHEET_PADDING = 14;

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not decode a shared image."));
    image.src = dataUrl;
  });
}

/** Builds a numbered chronological contact sheet without sending individual frames. */
export async function buildContactSheet(
  samples: readonly ContactSheetSample[],
  frameCount = samples.length,
) {
  if (samples.length === 0) throw new Error("Cannot build an empty contact sheet.");
  const images = await Promise.all(samples.map((sample) => loadImage(sample.dataUrl)));
  const columns = Math.ceil(Math.sqrt(frameCount));
  const rows = Math.ceil(frameCount / columns);
  const aspect = Math.max(...images.map((image) => image.naturalWidth / image.naturalHeight));
  const cellWidth = Math.min(Math.floor((MAX_SHEET_SIZE - SHEET_PADDING * 2) / columns), 1280);
  const cellHeight = Math.max(1, Math.round(cellWidth / aspect));
  const canvas = document.createElement("canvas");
  canvas.width = cellWidth * columns + SHEET_PADDING * 2;
  canvas.height = cellHeight * rows + SHEET_PADDING * 2;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Could not create a contact sheet canvas.");
  context.fillStyle = "#111";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.font = `${Math.max(14, Math.round(cellWidth / 32))}px sans-serif`;
  context.textBaseline = "top";
  images.forEach((image, index) => {
    const x = SHEET_PADDING + (index % columns) * cellWidth;
    const y = SHEET_PADDING + Math.floor(index / columns) * cellHeight;
    const scale = Math.min(cellWidth / image.naturalWidth, cellHeight / image.naturalHeight);
    const width = Math.round(image.naturalWidth * scale);
    const height = Math.round(image.naturalHeight * scale);
    context.drawImage(
      image,
      x + Math.floor((cellWidth - width) / 2),
      y + Math.floor((cellHeight - height) / 2),
      width,
      height,
    );
    context.fillStyle = "rgba(0, 0, 0, 0.72)";
    context.fillRect(x + 4, y + 4, 34, 24);
    context.fillStyle = "#fff";
    context.fillText(`${index + 1}`, x + 10, y + 6);
  });
  context.strokeStyle = "rgba(224, 168, 62, 0.9)";
  context.lineWidth = 10;
  context.strokeRect(5, 5, canvas.width - 10, canvas.height - 10);
  return {
    dataUrl: canvas.toDataURL("image/jpeg", 0.68),
    width: canvas.width,
    height: canvas.height,
  };
}
