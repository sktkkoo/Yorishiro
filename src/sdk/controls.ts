import { folder as levaFolder, type useCreateStore, useControls as useLevaControls } from "leva";

export type ControlSchema = Record<string, unknown>;
export type ControlSet = (values: Record<string, unknown>) => void;
export type ControlGet = (path: string) => unknown;
export type ControlStore = ReturnType<typeof useCreateStore>;
export type ControlHookResult<TValues extends Record<string, unknown> = Record<string, unknown>> = [
  TValues,
  ControlSet,
  ControlGet,
];

export interface ControlFolderSettings {
  readonly collapsed?: boolean;
  readonly color?: string;
  readonly order?: number;
  readonly render?: (get: (path: string) => unknown) => boolean;
}

export interface ControlHookSettings {
  readonly store?: ControlStore;
}

/**
 * Group controls under a collapsible folder.
 *
 * This is the SDK-facing wrapper for the current Leva adapter. Pack code should
 * import this from `@charminal/sdk/controls`, not from `leva`.
 */
export const controlFolder: typeof levaFolder = levaFolder;

/**
 * Register controls for the active scene pack.
 *
 * The current implementation renders through Leva, but the API is owned by
 * Charminal so the runtime can replace the panel renderer without changing
 * pack code.
 */
export const useCharminalControls: typeof useLevaControls = useLevaControls;
