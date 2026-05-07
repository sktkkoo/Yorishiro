import {
  createContext,
  createElement,
  type DependencyList,
  type ReactNode,
  useContext,
} from "react";
import {
  folder as levaFolder,
  type useCreateStore,
  useControls as useLevaControls,
} from "../runtime/leva";

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

type HookSettings = { store?: ControlStore };

const ControlStoreContext = createContext<ControlStore | null>(null);

export function ControlStoreProvider({
  children,
  store,
}: {
  readonly children: ReactNode;
  readonly store: ControlStore;
}) {
  return createElement(ControlStoreContext.Provider, { value: store }, children);
}

function hasStoreSettings(value: unknown): value is HookSettings {
  return typeof value === "object" && value !== null && "store" in value;
}

function withContextStore(settings: unknown, store: ControlStore): HookSettings {
  if (hasStoreSettings(settings))
    return settings.store === undefined ? { ...settings, store } : settings;
  return { store };
}

function injectStore(args: unknown[], store: ControlStore | null): unknown[] {
  if (store === null) return args;

  const [schemaOrFolderName, schemaOrSettings, depsOrSettingsOrFolderSettings, depsOrSettings] =
    args;

  if (typeof schemaOrFolderName === "string") {
    if (depsOrSettingsOrFolderSettings === undefined) {
      return [schemaOrFolderName, schemaOrSettings, { store }];
    }
    if (Array.isArray(depsOrSettingsOrFolderSettings)) {
      return [schemaOrFolderName, schemaOrSettings, { store }, depsOrSettingsOrFolderSettings];
    }
    if (hasStoreSettings(depsOrSettingsOrFolderSettings)) {
      return [
        schemaOrFolderName,
        schemaOrSettings,
        withContextStore(depsOrSettingsOrFolderSettings, store),
        ...args.slice(3),
      ];
    }
    if (depsOrSettings === undefined) {
      return [schemaOrFolderName, schemaOrSettings, depsOrSettingsOrFolderSettings, { store }];
    }
    if (Array.isArray(depsOrSettings)) {
      return [
        schemaOrFolderName,
        schemaOrSettings,
        depsOrSettingsOrFolderSettings,
        { store },
        depsOrSettings,
      ];
    }
    return [
      schemaOrFolderName,
      schemaOrSettings,
      depsOrSettingsOrFolderSettings,
      withContextStore(depsOrSettings, store),
      ...args.slice(4),
    ];
  }

  if (schemaOrSettings === undefined || Array.isArray(schemaOrSettings)) {
    return [schemaOrFolderName, { store }, schemaOrSettings as DependencyList | undefined];
  }
  return [schemaOrFolderName, withContextStore(schemaOrSettings, store), ...args.slice(2)];
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
export const useCharminalControls: typeof useLevaControls = ((
  ...args: Parameters<typeof useLevaControls>
) => {
  const contextStore = useContext(ControlStoreContext);
  return useLevaControls(
    ...(injectStore(args, contextStore) as Parameters<typeof useLevaControls>),
  );
}) as typeof useLevaControls;
