import {
  createContext,
  createElement,
  type DependencyList,
  type ReactNode,
  type RefObject,
  useContext,
  useEffect,
  useRef,
} from "react";
import type { Light } from "three";
import {
  folder as levaFolder,
  type useCreateStore,
  useControls as useLevaControls,
} from "../runtime/leva";
import {
  getMainLightRegistry,
  type MainLightBaseline,
  type MainLightRegistration,
} from "../runtime/three-runtime/main-light-registry";

export { useControlsBridge } from "../runtime/ui-state-store";

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
 * import this from `@yorishiro/sdk/controls`, not from `leva`.
 */
export const controlFolder: typeof levaFolder = levaFolder;

/**
 * Register controls for the active scene pack.
 *
 * The current implementation renders through Leva, but the API is owned by
 * Yorishiro so the runtime can replace the panel renderer without changing
 * pack code.
 */
export const useYorishiroControls: typeof useLevaControls = ((
  ...args: Parameters<typeof useLevaControls>
) => {
  const contextStore = useContext(ControlStoreContext);
  return useLevaControls(
    ...(injectStore(args, contextStore) as Parameters<typeof useLevaControls>),
  );
}) as typeof useLevaControls;

/**
 * Scene の main light を weather lighting に登録する。
 *
 * baseline は scene が所有する絶対値で、runtime は workspace mood を相対変調として
 * 合成する。登録しない scene では weather lighting は何もしない。
 */
export function useSceneMainLight<TLight extends Light>(
  lightRef: RefObject<TLight | null>,
  baseline: MainLightBaseline,
): void {
  const registrationRef = useRef<MainLightRegistration | null>(null);
  const baselineIntensity = baseline.intensity;
  const baselineColor = baseline.color;
  const latestBaselineRef = useRef<MainLightBaseline>({
    intensity: baselineIntensity,
    color: baselineColor,
  });
  latestBaselineRef.current = { intensity: baselineIntensity, color: baselineColor };

  useEffect(() => {
    const light = lightRef.current;
    if (!light) return;
    const registration = getMainLightRegistry().register(light, latestBaselineRef.current);
    registrationRef.current = registration;
    return () => {
      registration.dispose();
      if (registrationRef.current === registration) registrationRef.current = null;
    };
  }, [lightRef]);

  useEffect(() => {
    registrationRef.current?.update({ intensity: baselineIntensity, color: baselineColor });
  }, [baselineIntensity, baselineColor]);
}
