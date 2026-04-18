/**
 * Rust ↔ TS event channel の TS 側 dispatch logic。
 *
 * Rust の MCP server が tool call を受けると Tauri event を emit、TS 側が
 * 本 dispatch を通して対応する tool handler を走らせ、結果を event で Rust に
 * 返す。本 module は event 名 → handler の routing と error handling を
 * pure に閉じ、実 event listener の配線は caller（App.tsx / runtime）が行う。
 *
 * Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.5
 */

export type ToolHandler = (request: unknown) => Promise<unknown>;

export type ToolHandlerMap = Record<string, ToolHandler>;

export interface ToolEvent {
  readonly tool: string;
  readonly request: unknown;
}

export type ToolResponse =
  | { readonly ok: true; readonly payload: unknown }
  | { readonly ok: false; readonly reason: string };

export async function dispatchToolEvent(
  handlers: ToolHandlerMap,
  event: ToolEvent,
): Promise<ToolResponse> {
  const handler = handlers[event.tool];
  if (!handler) {
    return { ok: false, reason: `unknown tool: ${event.tool}` };
  }
  try {
    const payload = await handler(event.request);
    return { ok: true, payload };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}
