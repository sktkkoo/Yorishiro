import { describe, expect, it } from "vitest";
import {
  appendInitReloadErrorMarker,
  INIT_RELOAD_ERROR_MARKER,
  stripInitReloadErrorMarker,
} from "./init-changed-title";

describe("init reload title marker", () => {
  it("window title に init.js reload error marker を追加する", () => {
    expect(appendInitReloadErrorMarker("Charminal")).toBe(`Charminal${INIT_RELOAD_ERROR_MARKER}`);
  });

  it("既に marker が付いている title には二重付与しない", () => {
    const title = `Charminal${INIT_RELOAD_ERROR_MARKER}`;

    expect(appendInitReloadErrorMarker(title)).toBe(title);
  });

  it("追加した marker を剥がすと元の title に戻る", () => {
    const title = "Charminal";
    const appended = appendInitReloadErrorMarker(title);

    expect(stripInitReloadErrorMarker(appended)).toBe(title);
  });

  it("marker が無い title は strip しても変えない", () => {
    expect(stripInitReloadErrorMarker("Charminal")).toBe("Charminal");
  });

  it("Safe Mode suffix を保持したまま marker だけを剥がす", () => {
    const title = `Charminal (Safe Mode)${INIT_RELOAD_ERROR_MARKER}`;

    expect(stripInitReloadErrorMarker(title)).toBe("Charminal (Safe Mode)");
  });

  it("旧ビルドの Cmd+R marker も剥がす", () => {
    expect(stripInitReloadErrorMarker("Charminal — init.js changed (⌘R)")).toBe("Charminal");
  });
});
