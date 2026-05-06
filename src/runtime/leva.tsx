import type { useControls as baseUseControls, useCreateStore as baseUseCreateStore } from "leva";
import * as LevaBase from "leva/dist/leva.esm.js";
import { createContext, type DependencyList, type ReactNode, useContext } from "react";

export {
  button,
  buttonGroup,
  folder,
  Leva,
  LevaPanel,
  levaStore,
  monitor,
  useCreateStore,
} from "leva/dist/leva.esm.js";

export type LevaStore = ReturnType<typeof baseUseCreateStore>;

type HookSettings = { store?: LevaStore };

const SceneLevaStoreContext = createContext<LevaStore | null>(null);

export function SceneLevaStoreProvider({
  children,
  store,
}: {
  readonly children: ReactNode;
  readonly store: LevaStore;
}) {
  return <SceneLevaStoreContext.Provider value={store}>{children}</SceneLevaStoreContext.Provider>;
}

function hasStoreSettings(value: unknown): value is HookSettings {
  return typeof value === "object" && value !== null && "store" in value;
}

function withContextStore(settings: unknown, store: LevaStore): HookSettings {
  if (hasStoreSettings(settings))
    return settings.store === undefined ? { ...settings, store } : settings;
  return { store };
}

function injectStore(args: unknown[], store: LevaStore | null): unknown[] {
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

export const useControls: typeof baseUseControls = ((
  ...args: Parameters<typeof baseUseControls>
) => {
  const contextStore = useContext(SceneLevaStoreContext);
  return LevaBase.useControls(
    ...(injectStore(args, contextStore) as Parameters<typeof baseUseControls>),
  );
}) as typeof baseUseControls;
