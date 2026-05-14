export interface RegionPoint {
  readonly x: number;
  readonly y: number;
}

export interface RegionCell {
  readonly row: number;
  readonly col: number;
  readonly char: string;
}

export interface ExtractRegionTextInput {
  readonly rows: number;
  readonly cols: number;
  readonly cellWidth: number;
  readonly cellHeight: number;
  readonly polygon: ReadonlyArray<RegionPoint>;
  readonly getCell: (row: number, col: number) => string;
}

export interface ExtractedRegionText {
  readonly text: string;
  readonly cells: ReadonlyArray<RegionCell>;
  readonly startRow: number;
  readonly endRow: number;
  readonly startCol: number;
  readonly endCol: number;
}

export function pointInPolygon(point: RegionPoint, polygon: ReadonlyArray<RegionPoint>): boolean {
  if (polygon.length < 3) return false;

  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersects =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

export function polygonBounds(polygon: ReadonlyArray<RegionPoint>): {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
} | null {
  if (polygon.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
  };
}

export function extractRegionText(input: ExtractRegionTextInput): ExtractedRegionText | null {
  if (input.rows <= 0 || input.cols <= 0) return null;
  if (input.cellWidth <= 0 || input.cellHeight <= 0) return null;
  if (input.polygon.length < 3) return null;

  const bounds = polygonBounds(input.polygon);
  if (bounds === null || bounds.width === 0 || bounds.height === 0) return null;

  const minRow = clamp(Math.floor(bounds.y / input.cellHeight), 0, input.rows - 1);
  const maxRow = clamp(
    Math.floor((bounds.y + bounds.height) / input.cellHeight),
    0,
    input.rows - 1,
  );
  const minCol = clamp(Math.floor(bounds.x / input.cellWidth), 0, input.cols - 1);
  const maxCol = clamp(Math.floor((bounds.x + bounds.width) / input.cellWidth), 0, input.cols - 1);

  const cells: RegionCell[] = [];
  let startRow = Infinity;
  let endRow = -Infinity;
  let startCol = Infinity;
  let endCol = -Infinity;

  for (let row = minRow; row <= maxRow; row++) {
    for (let col = minCol; col <= maxCol; col++) {
      const center = {
        x: (col + 0.5) * input.cellWidth,
        y: (row + 0.5) * input.cellHeight,
      };
      if (!pointInPolygon(center, input.polygon)) continue;
      const char = input.getCell(row, col);
      cells.push({ row, col, char });
      startRow = Math.min(startRow, row);
      endRow = Math.max(endRow, row);
      startCol = Math.min(startCol, col);
      endCol = Math.max(endCol, col);
    }
  }

  if (cells.length === 0) return null;

  const byRow = new Map<number, RegionCell[]>();
  for (const cell of cells) {
    const rowCells = byRow.get(cell.row);
    if (rowCells) {
      rowCells.push(cell);
    } else {
      byRow.set(cell.row, [cell]);
    }
  }

  const lines: string[] = [];
  for (let row = startRow; row <= endRow; row++) {
    const rowCells = byRow.get(row) ?? [];
    rowCells.sort((a, b) => a.col - b.col);
    if (rowCells.length === 0) {
      lines.push("");
      continue;
    }
    const rowStart = rowCells[0].col;
    const rowEnd = rowCells[rowCells.length - 1].col;
    const chars = new Array<string>(rowEnd - rowStart + 1).fill(" ");
    for (const cell of rowCells) {
      chars[cell.col - rowStart] = cell.char;
    }
    lines.push(chars.join("").trimEnd());
  }

  return {
    text: lines.join("\n").trim(),
    cells,
    startRow,
    endRow,
    startCol,
    endCol,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
