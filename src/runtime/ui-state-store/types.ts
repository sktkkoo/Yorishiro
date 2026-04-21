/**
 * UiStateStore — UI pack と MCP bridge が共有する key-value state。
 *
 * SDK に公開する UiStateAPI は get / set / subscribe のみ。runtime 内では
 * MCP の get_ui_state 用に entries() も expose する。
 */

import type { Disposable } from "@charminal/sdk";

export interface UiStateStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  subscribe(key: string, listener: (value: unknown) => void): Disposable;
  entries(): Record<string, unknown>;
}
