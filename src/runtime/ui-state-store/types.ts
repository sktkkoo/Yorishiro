/**
 * UiStateStore — UI pack と MCP bridge が共有する pack-scoped key-value state。
 *
 * SDK に公開する UiStateAPI は get / set / subscribe のみ。runtime 内では
 * MCP の get_ui_state 用に entries() も expose する。ctx.state は App.tsx で
 * active UI pack id に bind した view として pack へ渡す。
 */

import type { Disposable } from "@charminal/sdk";

export interface UiStateStore {
  get(packId: string, key: string): unknown;
  set(packId: string, key: string, value: unknown): void;
  subscribe(packId: string, key: string, listener: (value: unknown) => void): Disposable;
  entries(packId: string): Record<string, unknown>;
}
