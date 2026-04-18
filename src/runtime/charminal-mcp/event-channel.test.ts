/**
 * Rust ↔ TS event channel の handler dispatch logic — pure fn テスト。
 *
 * Tauri event listener 自体の contract は production 配線で確認する。
 * ここでは「event 名 → handler routing」「unknown handler の扱い」だけ
 * pure fn として固定する。
 */

import { describe, expect, it } from "vitest";
import { dispatchToolEvent, type ToolHandlerMap } from "./event-channel";

describe("dispatchToolEvent", () => {
  it("routes to the matching handler and returns its result", async () => {
    const handlers: ToolHandlerMap = {
      "list-packs": async () => ({
        packs: [{ id: "a", kind: "effect", status: "loaded" }],
      }),
    };
    const result = await dispatchToolEvent(handlers, {
      tool: "list-packs",
      request: {},
    });
    expect(result).toEqual({
      ok: true,
      payload: { packs: [{ id: "a", kind: "effect", status: "loaded" }] },
    });
  });

  it("returns ok:false when the tool name is unknown", async () => {
    const result = await dispatchToolEvent(
      {},
      {
        tool: "unknown",
        request: {},
      },
    );
    expect(result).toEqual({
      ok: false,
      reason: "unknown tool: unknown",
    });
  });

  it("catches handler throws and converts to ok:false", async () => {
    const handlers: ToolHandlerMap = {
      boom: async () => {
        throw new Error("inner failure");
      },
    };
    const result = await dispatchToolEvent(handlers, {
      tool: "boom",
      request: {},
    });
    expect(result).toEqual({
      ok: false,
      reason: "inner failure",
    });
  });
});
