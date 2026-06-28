/**
 * User pack watcher — Rust 側の `watch_charminal_layer` から file event を受けて
 * `packRegistry` と各 registrar を同期する hot-reload の主動脈。
 *
 * 純粋 logic（path parse / action mapping）は `watcher-logic.ts` に切り出して
 * vitest で検証しているので、本 module は Tauri invoke + dynamic import の
 * 組み立てに責任を限定する。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「生きた系」
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-b」Section B4
 */

import type { EffectDefinition, PersonaDefinition } from "@charminal/sdk";
import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { SubsystemLog } from "../../core/dev-log";
import {
  validateAmbientUiPackDefinition,
  validateAmenityDefinition,
  validateEffectDefinition,
  validatePersonaDefinition,
  validateUiPackDefinition,
} from "../../sdk/validators";
import type { AmbientUiPackRegistry } from "../ambient-ui-pack-registry";
import type { AmenityPackRegistry } from "../amenity-pack-registry";
import type { PersonaEntry } from "../persona-registry";
import type { ScenePackRegistry } from "../scene-pack-registry";
import type { UiPackRegistry } from "../ui-pack-registry";
import { type AmenityContextFactory, activateAndRegisterAmenity } from "./amenity-activation";
import type { InitScope } from "./init-scope";
import { type LoadInitScriptDeps, reloadInitScript } from "./init-script";
import { readManifestForEntry, validatePackExecutionPolicy } from "./pack-execution-policy";
import { applyPersonaDefaults } from "./persona-defaults";
import { injectPersonaPrompt } from "./persona-md-injection";
import { registerScenePack } from "./scene-pack-integration";
import type { EffectRegistrar, PersonaRegistrar } from "./user-pack-loader";
import type { UserPackRegistry } from "./user-pack-registry";
import { type CharminalLayerEvent, mapEventToAction, type WatcherAction } from "./watcher-logic";

export interface StartPackWatcherDeps {
  readonly effectPackRunner: EffectRegistrar;
  readonly personaRegistry: PersonaRegistrar;
  readonly scenePackRegistry: ScenePackRegistry;
  readonly uiPackRegistry: UiPackRegistry;
  readonly ambientUiPackRegistry: AmbientUiPackRegistry;
  readonly amenityPackRegistry: AmenityPackRegistry;
  readonly createAmenityContext?: AmenityContextFactory;
  readonly packRegistry: UserPackRegistry;
  readonly personaDefaults?: PersonaDefinition;
  readonly userPackLog: SubsystemLog;
  readonly initScriptLog: SubsystemLog;
  readonly onInitChanged?: () => void;
  /**
   * init.js hot reload 用の deps と、現在 active な init scope の holder。
   * 未指定なら従来通り「変更を log + onInitChanged のみ」（reload しない）。
   */
  readonly initReload?: InitReloadConfig;
}

/**
 * watcher が init.js 変更時に reloadInitScript を呼ぶための束ね。`buildDeps` は
 * 毎回新しい `LoadInitScriptDeps` を作る（cache-bust import path 等を都度組む）。
 * `handleRef.current` が現在 active な scope で、reload 後に差し替える。
 */
export interface InitReloadConfig {
  readonly buildDeps: () => LoadInitScriptDeps;
  readonly handleRef: { current: InitScope | null };
  /**
   * init.js reload の single-flight queue。Tauri Channel は次の message を待たずに
   * delivery しうるので、async reload が並行すると同じ previous handle から二重に
   * 差し替わり scope が leak する。ここに Promise chain を保持し、変更イベントを
   * 逐次処理する。
   */
  readonly queueRef: { current: Promise<void> };
  /**
   * reload 成否を呼び出し側へ通知する（title marker の付け外し等）。
   * `missing` は init.js が削除された正常遷移（error ではない）。
   */
  readonly onReloaded?: (result: { ran: boolean; error?: string; missing?: boolean }) => void;
}

export interface PackWatcherHandle {
  /** 現状の Tauri command は停止 API を持たないので noop だが、interface は保つ。 */
  readonly dispose: () => void;
}

const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const extractDefault = (mod: unknown): unknown => {
  if (mod === null || typeof mod !== "object") return undefined;
  return (mod as { default?: unknown }).default;
};

/**
 * watcher を張って event loop を開始する。`Promise` が resolve した時点で Rust
 * 側 watcher は起動済みで、以降の event は Channel 経由で受け取る。
 *
 * 起動失敗時は dev-log に痕跡を残して reject せず、noop handle を返す。watcher
 * が止まっていても Charminal 本体は動く——philosophy「壊さないこと」の典型適用。
 */
export async function startPackWatcher(deps: StartPackWatcherDeps): Promise<PackWatcherHandle> {
  let charminalHome: string;
  try {
    charminalHome = await invoke<string>("charminal_home_dir");
  } catch (err) {
    deps.userPackLog.write({
      phase: "watch",
      note: "failed to resolve ~/.charminal/ path; watcher disabled",
      data: { error: errorMessage(err) },
    });
    return { dispose: () => {} };
  }

  const channel = new Channel<CharminalLayerEvent>();
  channel.onmessage = (event) => {
    void handleLayerEvent(event, charminalHome, deps, { invoke, convertFileSrc });
  };

  try {
    await invoke("watch_charminal_layer", { onEvent: channel });
    deps.userPackLog.write({
      phase: "watch",
      note: `watching ${charminalHome}`,
    });
  } catch (err) {
    deps.userPackLog.write({
      phase: "watch",
      note: "watcher failed to start; hot reload disabled for this session",
      data: { error: errorMessage(err) },
    });
  }

  return { dispose: () => {} };
}

interface TauriBindings {
  readonly invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>;
  readonly convertFileSrc: (filePath: string, protocol?: string) => string;
}

async function handleLayerEvent(
  event: CharminalLayerEvent,
  charminalHome: string,
  deps: StartPackWatcherDeps,
  tauri: TauriBindings,
): Promise<void> {
  const action = mapEventToAction(event, charminalHome);

  switch (action.type) {
    case "ignore":
      return;

    case "init-changed":
      await handleInitChanged(action, deps);
      return;

    case "remove-pack": {
      if (!deps.packRegistry.has(action.id, action.kind)) {
        return;
      }
      deps.packRegistry.dispose(action.id, action.kind);
      deps.userPackLog.write({
        phase: "reload",
        note: `disposed ${action.kind} '${action.id}'`,
      });
      return;
    }

    case "reload-pack":
      await reloadPack(action, deps, tauri);
      return;
  }
}

/**
 * init.js の変更を hot reload に落とす。`initReload` が無いときは従来の挙動
 * （log + onInitChanged）に劣化させ、Cmd/Ctrl+R 経路でも壊れないようにする。
 */
async function handleInitChanged(
  action: Extract<WatcherAction, { type: "init-changed" }>,
  deps: StartPackWatcherDeps,
): Promise<void> {
  if (deps.initReload === undefined) {
    deps.initScriptLog.write({
      phase: "reload",
      note: "init.js changed; press Cmd/Ctrl+R to reload",
      data: { path: action.path },
    });
    deps.onInitChanged?.();
    return;
  }

  const { buildDeps, handleRef, onReloaded } = deps.initReload;
  const { queueRef } = deps.initReload;
  const runReload = async (): Promise<void> => {
    try {
      const result = await reloadInitScript(buildDeps(), handleRef.current);
      handleRef.current = result.handle;
      onReloaded?.({ ran: result.ran, error: result.error, missing: result.missing });
    } catch (err) {
      deps.initScriptLog.write({
        phase: "reload",
        note: "init.js hot reload crashed",
        data: { path: action.path, error: errorMessage(err) },
      });
    }
  };

  const queued = queueRef.current.catch(() => {}).then(runReload);
  // Keep the chain alive even if a future edit somehow throws outside runReload.
  queueRef.current = queued.catch(() => {});
  await queued;
}

async function reloadPack(
  action: Extract<WatcherAction, { type: "reload-pack" }>,
  deps: StartPackWatcherDeps,
  tauri: TauriBindings,
): Promise<void> {
  const manifest = await readManifestForEntry(action.entryPath, {
    convertFileSrc: tauri.convertFileSrc,
  });
  const policyError = validatePackExecutionPolicy({
    id: action.id,
    kind: action.kind,
    entryPath: action.entryPath,
    source: "local",
    manifest,
  });
  if (policyError !== null) {
    deps.userPackLog.write({
      phase: "policy",
      note: `blocked reload for '${action.id}' (${action.kind}): ${policyError}`,
      data: { entryPath: action.entryPath },
    });
    return;
  }

  // ?v=<mtime> で engine の module registry を bust しないと、同じ URL で 2 度目
  // の import は cache hit を返す（pitfall #11）。watcher からの mtimeMs が 0
  // だった場合は stat_file_mtime で取り直す。
  let cacheKey = action.mtimeMs;
  if (cacheKey <= 0) {
    try {
      cacheKey = await tauri.invoke<number>("stat_file_mtime", { path: action.entryPath });
    } catch (err) {
      deps.userPackLog.write({
        phase: "reload",
        note: `failed to stat mtime for '${action.id}' (${action.kind})`,
        data: { entryPath: action.entryPath, error: errorMessage(err) },
      });
      return;
    }
  }

  let mod: unknown;
  try {
    if (action.entryPath.endsWith(".tsx")) {
      const { importUiTsxEntry } = await import("./tsx-transpiler");
      mod = await importUiTsxEntry(
        action.entryPath,
        { convertFileSrc: tauri.convertFileSrc },
        { cacheKey },
      );
    } else {
      const url = `${tauri.convertFileSrc(action.entryPath)}?v=${cacheKey}`;
      mod = await import(/* @vite-ignore */ url);
    }
  } catch (err) {
    deps.userPackLog.write({
      phase: "reload",
      note: `dynamic import failed for '${action.id}' (${action.kind})`,
      data: { entryPath: action.entryPath, error: errorMessage(err) },
    });
    return;
  }

  const def = extractDefault(mod);
  if (def === undefined) {
    deps.userPackLog.write({
      phase: "reload",
      note: `module has no default export for '${action.id}' (${action.kind})`,
      data: { entryPath: action.entryPath },
    });
    return;
  }

  try {
    if (action.kind === "effect") {
      const pack: EffectDefinition = validateEffectDefinition(def);
      // 旧 Disposable を先に畳んでから新しい register を走らせる。registry.register
      // 内部でも prev dispose が走るが、register の失敗（persona で duplicate
      // throw 等）を早く検知できるように先出しする。
      deps.packRegistry.dispose(action.id, action.kind);
      const handle = deps.effectPackRunner.register(pack);
      deps.packRegistry.register(action.id, action.kind, handle);
      deps.userPackLog.write({
        phase: "reload",
        note: `re-registered effect '${pack.id}'`,
      });
    } else if (action.kind === "persona") {
      const personaDef: PersonaDefinition = validatePersonaDefinition(def);

      // persona.md を再 fetch して inject する。hot reload 時に persona.md を
      // user が編集しても反映されるよう、毎回 fetch し直す。
      // watcher では tauri.convertFileSrc が注入済みなので直接使う。
      const packDir = action.entryPath.replace(/\/persona\.js$/, "");
      const mdUrl = tauri.convertFileSrc(`${packDir}/persona.md`);
      let mdText = "";
      try {
        const response = await fetch(mdUrl);
        if (response.ok) {
          mdText = await response.text();
        }
      } catch (err) {
        deps.userPackLog.write({
          phase: "reload",
          note: `persona "${action.id}": persona.md fetch failed (${errorMessage(err)})`,
        });
      }
      const injected = applyPersonaDefaults(
        injectPersonaPrompt(personaDef, mdText),
        deps.personaDefaults,
      );

      const personaEntry: PersonaEntry = {
        id: injected.id,
        manifest: {
          id: injected.id,
          type: "persona",
          version: "0.0.0",
          charminalVersion: "*",
          entry: "persona.js",
        },
        persona: injected,
        origin: "user",
        entryPath: action.entryPath,
      };
      deps.packRegistry.dispose(action.id, action.kind);
      const handle = deps.personaRegistry.register(personaEntry);
      deps.packRegistry.register(action.id, action.kind, handle);
      deps.userPackLog.write({
        phase: "reload",
        note: `re-registered persona '${injected.id}'`,
      });
    } else if (action.kind === "scene") {
      const sceneResult = await registerScenePack({
        id: action.id,
        entryPath: action.entryPath,
        def,
        packRegistry: deps.packRegistry,
        scenePackRegistry: deps.scenePackRegistry,
        devLog: deps.userPackLog,
        convertFileSrc: tauri.convertFileSrc,
        logPhase: { manifestError: "reload", register: "reload" },
      });
      if (sceneResult.status === "failed") {
        // エラーは registerScenePack 内で devLog に書き出し済み。
        return;
      }
    } else if (action.kind === "ui") {
      const pack = validateUiPackDefinition(def);
      deps.packRegistry.dispose(action.id, action.kind);
      const handle = deps.uiPackRegistry.register({
        id: pack.id,
        manifest: {
          id: pack.id,
          type: "ui",
          version: "0.0.0",
          charminalVersion: "*",
          entry: action.entryPath.endsWith(".tsx") ? "ui.tsx" : "ui.js",
        },
        origin: "user",
        pack: {
          layout: pack.layout,
          mount: pack.mount,
        },
      });
      deps.packRegistry.register(action.id, action.kind, handle);
      deps.userPackLog.write({
        phase: "reload",
        note: `re-registered ui '${pack.id}'`,
      });
    } else if (action.kind === "ambient-ui") {
      const pack = validateAmbientUiPackDefinition(def);
      deps.packRegistry.dispose(action.id, action.kind);
      const handle = deps.ambientUiPackRegistry.register({
        id: pack.id,
        origin: "user",
        manifest: {
          id: pack.id,
          type: "ambient-ui",
          version: "0.0.0",
          charminalVersion: "*",
          entry: action.entryPath.endsWith(".tsx") ? "ui.tsx" : "ui.js",
        },
        pack: { mount: pack.mount },
      });
      deps.packRegistry.register(action.id, action.kind, handle);
      deps.userPackLog.write({
        phase: "reload",
        note: `re-registered ambient-ui '${pack.id}'`,
      });
    } else if (action.kind === "amenity") {
      const pack = validateAmenityDefinition(def);
      // 旧 activate を畳んでから再 activate する。packRegistry.register 側も同 key を auto-dispose する。
      deps.packRegistry.dispose(action.id, action.kind);
      if (deps.createAmenityContext === undefined) {
        deps.userPackLog.write({
          phase: "reload",
          note: `amenity '${pack.id}' validated (no context factory; activate skipped)`,
        });
      } else {
        await activateAndRegisterAmenity({
          registryId: action.id,
          def: pack,
          entryPath: action.entryPath,
          amenityPackRegistry: deps.amenityPackRegistry,
          packRegistry: deps.packRegistry,
          createAmenityContext: deps.createAmenityContext,
        });
        deps.userPackLog.write({
          phase: "reload",
          note: `re-activated amenity '${pack.id}' (id=${action.id})`,
        });
      }
    }
  } catch (err) {
    deps.userPackLog.write({
      phase: "reload",
      note: `reload failed for '${action.id}' (${action.kind})`,
      data: { error: errorMessage(err) },
    });
  }
}
