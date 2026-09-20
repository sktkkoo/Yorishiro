import type { IParser } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { TerminalColorScheme } from "./color-scheme";

function setup() {
  const handlers = new Map<string, (params: (number | number[])[]) => boolean | Promise<boolean>>();
  const dispose = vi.fn();
  const parser = {
    registerCsiHandler: (id, handler) => {
      handlers.set(`${id.prefix ?? ""}${id.intermediates ?? ""}${id.final}`, handler);
      return { dispose };
    },
    registerEscHandler: (_id, handler) => {
      handlers.set("reset", handler);
      return { dispose };
    },
  } satisfies Pick<IParser, "registerCsiHandler" | "registerEscHandler">;
  const reply = vi.fn();
  const scheme = new TerminalColorScheme(parser, (data) => reply(data));
  const send = (id: string, ...params: (number | number[])[]) => handlers.get(id)?.(params);
  return { scheme, reply, send, dispose };
}

describe("terminal color scheme reporting", () => {
  it("keeps ordinary shells silent and answers explicit mode and color queries", () => {
    const { scheme, reply, send } = setup();
    scheme.update("rgba(231,231,217,1)");
    expect(reply).not.toHaveBeenCalled();
    expect(send("?$p", 2031)).toBe(true);
    expect(reply).toHaveBeenLastCalledWith("\x1b[?2031;2$y");
    expect(send("?n", 996)).toBe(true);
    expect(reply).toHaveBeenLastCalledWith("\x1b[?997;2n");
    expect(send("?n", 6)).toBe(false);
    expect(send("?$p", 2004)).toBe(false);
  });

  it("notifies subscribed TUIs across Cafe, Simple Room, and Misty Grasslands", () => {
    const { scheme, reply, send } = setup();
    scheme.update("rgba(231,231,217,1)");
    send("?h", 2031);
    scheme.update("rgba(20,22,25,1)");
    scheme.update("rgba(214,220,200,1)");
    scheme.update("rgba(231,231,217,1)");
    scheme.update("rgba(231,231,217,1)");
    expect(reply.mock.calls).toEqual([["\x1b[?997;1n"], ["\x1b[?997;2n"], ["\x1b[?997;2n"]]);
  });

  it("passes combined modes through and stops notifications on disable or reset", () => {
    const { scheme, reply, send } = setup();
    expect(send("?h", 2004, 2031)).toBe(false);
    send("?$p", 2031);
    expect(reply).toHaveBeenLastCalledWith("\x1b[?2031;1$y");
    send("?l", 2031);
    reply.mockClear();
    scheme.update("rgba(255,255,255,1)");
    send("?h", 2031);
    expect(send("reset")).toBe(false);
    scheme.update("rgba(0,0,0,1)");
    expect(reply).not.toHaveBeenCalled();
  });

  it("resets subscriptions between sessions and disposes parser hooks", () => {
    const { scheme, reply, send, dispose } = setup();
    send("?h", 2031);
    scheme.reset();
    scheme.update("rgba(255,255,255,1)");
    expect(reply).not.toHaveBeenCalled();
    scheme.dispose();
    expect(dispose).toHaveBeenCalledTimes(5);
  });
});
