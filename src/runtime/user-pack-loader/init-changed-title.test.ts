import { describe, expect, it } from "vitest";
import {
  appendInitReloadErrorMarker,
  INIT_RELOAD_ERROR_MARKER,
  stripInitReloadErrorMarker,
} from "./init-changed-title";

describe("init reload title marker", () => {
  it("window title に init.js reload error marker を追加する", () => {
    expect(appendInitReloadErrorMarker("Yorishiro")).toBe(`Yorishiro${INIT_RELOAD_ERROR_MARKER}`);
  });

  it("既に marker が付いている title には二重付与しない", () => {
    const title = `Yorishiro${INIT_RELOAD_ERROR_MARKER}`;

    expect(appendInitReloadErrorMarker(title)).toBe(title);
  });

  it("追加した marker を剥がすと元の title に戻る", () => {
    const title = "Yorishiro";
    const appended = appendInitReloadErrorMarker(title);

    expect(stripInitReloadErrorMarker(appended)).toBe(title);
  });

  it("marker が無い title は strip しても変えない", () => {
    expect(stripInitReloadErrorMarker("Yorishiro")).toBe("Yorishiro");
  });

  it("Safe Mode suffix を保持したまま marker だけを剥がす", () => {
    const title = `Yorishiro (Safe Mode)${INIT_RELOAD_ERROR_MARKER}`;

    expect(stripInitReloadErrorMarker(title)).toBe("Yorishiro (Safe Mode)");
  });

  it("旧ビルドの Cmd+R marker も剥がす", () => {
    expect(stripInitReloadErrorMarker("Yorishiro — init.js changed (⌘R)")).toBe("Yorishiro");
  });
});
