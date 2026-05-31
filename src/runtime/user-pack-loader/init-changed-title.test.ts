import { describe, expect, it } from "vitest";
import {
  appendInitChangedMarker,
  INIT_CHANGED_MARKER,
  stripInitChangedMarker,
} from "./init-changed-title";

describe("init-changed title marker", () => {
  it("window title に init.js 変更 marker を追加する", () => {
    expect(appendInitChangedMarker("Charminal")).toBe(`Charminal${INIT_CHANGED_MARKER}`);
  });

  it("既に marker が付いている title には二重付与しない", () => {
    const title = `Charminal${INIT_CHANGED_MARKER}`;

    expect(appendInitChangedMarker(title)).toBe(title);
  });

  it("追加した marker を剥がすと元の title に戻る", () => {
    const title = "Charminal";
    const appended = appendInitChangedMarker(title);

    expect(stripInitChangedMarker(appended)).toBe(title);
  });

  it("marker が無い title は strip しても変えない", () => {
    expect(stripInitChangedMarker("Charminal")).toBe("Charminal");
  });

  it("Safe Mode suffix を保持したまま marker だけを剥がす", () => {
    const title = `Charminal (Safe Mode)${INIT_CHANGED_MARKER}`;

    expect(stripInitChangedMarker(title)).toBe("Charminal (Safe Mode)");
  });
});
