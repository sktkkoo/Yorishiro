/**
 * UI pack TSX transpiler — Plan 4 MVP.
 *
 * This intentionally supports only a single `ui.tsx` entry file. Relative
 * imports and persistent `.build` output are follow-up work once the core
 * user UI pack path is proven.
 */

import * as esbuild from "esbuild-wasm";
import esbuildWasmUrl from "esbuild-wasm/esbuild.wasm?url";
import type * as React from "react";
import type * as ReactJsxRuntime from "react/jsx-runtime";
import type * as ReactDomClient from "react-dom/client";

const HOST_NAMESPACE = "charminal-host";
const UNSUPPORTED_NAMESPACE = "charminal-unsupported";

declare global {
  var __CHARMINAL_REACT__: typeof React | undefined;
  var __CHARMINAL_REACT_DOM_CLIENT__: typeof ReactDomClient | undefined;
  var __CHARMINAL_REACT_JSX_RUNTIME__: typeof ReactJsxRuntime | undefined;
}

export interface TsxTranspilerDeps {
  readonly convertFileSrc: (filePath: string, protocol?: string) => string;
}

export interface TsxTranspilerOptions {
  readonly cacheKey?: string | number;
}

let initializePromise: Promise<void> | null = null;

export function isTsxEntryPath(entryPath: string): boolean {
  return entryPath.endsWith(".tsx");
}

function ensureEsbuildInitialized(): Promise<void> {
  initializePromise ??= esbuild.initialize({
    wasmURL: esbuildWasmUrl,
    worker: true,
  });
  return initializePromise;
}

export function buildTsxEntryUrl(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): string {
  const url = deps.convertFileSrc(entryPath);
  if (options.cacheKey === undefined) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}v=${encodeURIComponent(String(options.cacheKey))}`;
}

async function readEntrySource(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): Promise<string> {
  const url = buildTsxEntryUrl(entryPath, deps, options);
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`failed to read TSX entry (${response.status} ${response.statusText})`);
  }
  return response.text();
}

const reactShim = `
const React = globalThis.__CHARMINAL_REACT__;
if (!React) throw new Error("Charminal React host bridge is not initialized");
export default React;
export const Children = React.Children;
export const Component = React.Component;
export const Fragment = React.Fragment;
export const Profiler = React.Profiler;
export const PureComponent = React.PureComponent;
export const StrictMode = React.StrictMode;
export const Suspense = React.Suspense;
export const cloneElement = React.cloneElement;
export const createContext = React.createContext;
export const createElement = React.createElement;
export const createRef = React.createRef;
export const forwardRef = React.forwardRef;
export const isValidElement = React.isValidElement;
export const lazy = React.lazy;
export const memo = React.memo;
export const startTransition = React.startTransition;
export const useCallback = React.useCallback;
export const useContext = React.useContext;
export const useDebugValue = React.useDebugValue;
export const useDeferredValue = React.useDeferredValue;
export const useEffect = React.useEffect;
export const useId = React.useId;
export const useImperativeHandle = React.useImperativeHandle;
export const useInsertionEffect = React.useInsertionEffect;
export const useLayoutEffect = React.useLayoutEffect;
export const useMemo = React.useMemo;
export const useReducer = React.useReducer;
export const useRef = React.useRef;
export const useState = React.useState;
export const useSyncExternalStore = React.useSyncExternalStore;
export const useTransition = React.useTransition;
`;

const reactDomClientShim = `
const ReactDomClient = globalThis.__CHARMINAL_REACT_DOM_CLIENT__;
if (!ReactDomClient) throw new Error("Charminal React DOM client host bridge is not initialized");
export const createRoot = ReactDomClient.createRoot;
export const hydrateRoot = ReactDomClient.hydrateRoot;
`;

const jsxRuntimeShim = `
const Runtime = globalThis.__CHARMINAL_REACT_JSX_RUNTIME__;
if (!Runtime) throw new Error("Charminal React JSX runtime bridge is not initialized");
export const Fragment = Runtime.Fragment;
export const jsx = Runtime.jsx;
export const jsxs = Runtime.jsxs;
`;

const sdkShim = `
export {};
`;

function createPlan4MvpPlugin(): esbuild.Plugin {
  return {
    name: "charminal-ui-pack-plan4-mvp",
    setup(build) {
      build.onResolve(
        { filter: /^(react|react-dom\/client|react\/jsx-runtime|@charminal\/sdk)$/ },
        (args) => ({
          path: args.path,
          namespace: HOST_NAMESPACE,
        }),
      );
      build.onResolve({ filter: /^\.{1,2}\// }, (args) => ({
        path: args.path,
        namespace: UNSUPPORTED_NAMESPACE,
        pluginData: "relative imports are not supported for ui.tsx in Plan 4 MVP",
      }));
      build.onResolve({ filter: /.*/ }, (args) => ({
        path: args.path,
        namespace: UNSUPPORTED_NAMESPACE,
        pluginData: `unsupported import '${args.path}' in ui.tsx Plan 4 MVP`,
      }));
      build.onLoad({ filter: /.*/, namespace: HOST_NAMESPACE }, (args) => {
        if (args.path === "react") {
          return { contents: reactShim, loader: "js" };
        }
        if (args.path === "react/jsx-runtime") {
          return { contents: jsxRuntimeShim, loader: "js" };
        }
        if (args.path === "react-dom/client") {
          return { contents: reactDomClientShim, loader: "js" };
        }
        return { contents: sdkShim, loader: "js" };
      });
      build.onLoad({ filter: /.*/, namespace: UNSUPPORTED_NAMESPACE }, (args) => ({
        errors: [{ text: String(args.pluginData) }],
      }));
    },
  };
}

export async function transpileUiTsxEntry(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): Promise<string> {
  await ensureEsbuildInitialized();
  const source = await readEntrySource(entryPath, deps, options);
  const result = await esbuild.build({
    bundle: true,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    stdin: {
      contents: source,
      loader: "tsx",
      resolveDir: "/",
      sourcefile: entryPath,
    },
    target: "es2020",
    treeShaking: true,
    write: false,
    plugins: [createPlan4MvpPlugin()],
  });
  const output = result.outputFiles?.[0]?.text;
  if (output === undefined) {
    throw new Error("esbuild-wasm produced no output");
  }
  return output;
}

export async function importUiTsxEntry(
  entryPath: string,
  deps: TsxTranspilerDeps,
  options: TsxTranspilerOptions = {},
): Promise<unknown> {
  const code = await transpileUiTsxEntry(entryPath, deps, options);
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}
