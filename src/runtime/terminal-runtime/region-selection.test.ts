import { describe, expect, it } from "vitest";
import { extractRegionText, pointInPolygon } from "./region-selection";

describe("pointInPolygon", () => {
  const square = [
    { x: 0, y: 0 },
    { x: 20, y: 0 },
    { x: 20, y: 20 },
    { x: 0, y: 20 },
  ];

  it("detects points inside and outside a polygon", () => {
    expect(pointInPolygon({ x: 10, y: 10 }, square)).toBe(true);
    expect(pointInPolygon({ x: 25, y: 10 }, square)).toBe(false);
  });

  it("returns false for incomplete polygons", () => {
    expect(pointInPolygon({ x: 1, y: 1 }, square.slice(0, 2))).toBe(false);
  });
});

describe("extractRegionText", () => {
  const rows = ["hello world", "build failed", "src/App.tsx"];

  it("extracts text from cells whose centers are inside the polygon", () => {
    const result = extractRegionText({
      rows: 3,
      cols: 12,
      cellWidth: 10,
      cellHeight: 20,
      polygon: [
        { x: 0, y: 20 },
        { x: 120, y: 20 },
        { x: 120, y: 60 },
        { x: 0, y: 60 },
      ],
      getCell: (row, col) => rows[row]?.[col] ?? " ",
    });

    expect(result?.text).toBe("build failed\nsrc/App.tsx");
    expect(result?.startRow).toBe(1);
    expect(result?.endRow).toBe(2);
  });

  it("returns null when no cell centers are enclosed", () => {
    const result = extractRegionText({
      rows: 3,
      cols: 12,
      cellWidth: 10,
      cellHeight: 20,
      polygon: [
        { x: 0, y: 0 },
        { x: 1, y: 0 },
        { x: 1, y: 1 },
      ],
      getCell: (row, col) => rows[row]?.[col] ?? " ",
    });

    expect(result).toBeNull();
  });
});
