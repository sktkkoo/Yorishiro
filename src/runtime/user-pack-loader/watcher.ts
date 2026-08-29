/**
 * User pack watcher — Rust 側の `watch_yorishiro_layer` から file event を受けて
 * `packRegistry` と各 registrar を同期する hot-reload の主動脈。
 *
 * 純粋 logic（path parse / action mapping）は `watcher-logic.ts` に切り出して
 * vitest で検証しているので、本 module は Tauri invoke + dynamic import の
 * 組み立てに責任を限定する。
 *
 * Philosophy: docs/philosophy/PHILOSOPHY.md「生きた系」
 * Internal design-record: 2026-04-18-user-layer-runtime.md「Phase 1-b」Section B4
 */

import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { EffectDefinition, PersonaDefinition } from "@yorishiro/sdk";
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
import type { AmbientUiRegistrationEvent } from "./ambient-ui-activation";
import { type AmenityContextFactory, activateAndRegisterAmenity } from "./amenity-activation";
import type { InitScope } from "./init-scope";
import { type LoadInitScriptDeps, reloadInitScript } from "./init-script";
import {
  type PackExecutionEnvironment,
  readManifestForEntry,
  validatePackExecutionPolicy,
} from "./pack-execution-policy";
import { applyPersonaDefaults } from "./persona-defaults";
import { injectPersonaPrompt } from "./persona-md-injection";
import { registerScenePack } from "./scene-pack-integration";
import {
  type EffectRegistrar,
  type PersonaRegistrar,
  type UserPackEntry,
  userPackEntryFilename,
} from "./user-pack-loader";
import type { UserPackRegistry } from "./user-pack-registry";
import { mapEventToAction, type WatcherAction, type YorishiroLayerEvent } from "./watcher-logic";

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
   * ambient-ui の atomic register が完了した直後に対象 id だけを通知する。
   * 削除 / import・validation failure 時には呼ばない。
   */
  readonly onAmbientUiRegistered?: (event: AmbientUiRegistrationEvent) => void | Promise<void>;
  readonly executionEnvironment?: PackExecutionEnvironment;
  /** safe mode では false。watch は維持するが user pack の import / register は行わない。 */
  readonly packReloadEnabled?: boolean;
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
 * Atomic-save の remove → create burst を同一 replacement とみなす猶予。
 * Rust producer は 150ms 周期で pending events を drain するため、remove/create が
 * 隣接 drain に分かれても十分吸収できるよう 3 周期超を確保する。
 */
const AMBIENT_UI_REMOVE_GRACE_MS = 500;

/**
 * watcher を張って event loop を開始する。`Promise` が resolve した時点で Rust
 * 側 watcher は起動済みで、以降の event は Channel 経由で受け取る。
 *
 * 起動失敗時は dev-log に痕跡を残して reject せず、noop handle を返す。watcher
 * が止まっていても Yorishiro 本体は動く——philosophy「壊さないこと」の典型適用。
 */
export async function startPackWatcher(deps: StartPackWatcherDeps): Promise<PackWatcherHandle> {
  let yorishiroHome: string;
  try {
    yorishiroHome = await invoke<string>("yorishiro_home_dir");
  } catch (err) {
    deps.userPackLog.write({
      phase: "watch",
      note: "failed to resolve ~/.yorishiro/ path; watcher disabled",
      data: { error: errorMessage(err) },
    });
    return { dispose: () => {} };
  }

  const channel = new Channel<YorishiroLayerEvent>();
  const eventQueues = new Map<string, Promise<void>>();
  const pendingAmbientUiRemovals = new Map<string, ReturnType<typeof setTimeout>>();
  const enqueueEvent = (event: YorishiroLayerEvent, action: WatcherAction): void => {
    const queueKey =
      action.type === "reload-pack" ||
      action.type === "reload-pack-source" ||
      action.type === "remove-pack"
        ? `pack:${action.id}`
        : action.type === "init-changed"
          ? "init"
          : null;
    if (queueKey === null) return;

    // Editors using atomic save commonly emit remove -> create back-to-back. Serialize
    // events per pack id so an older async import cannot win after a newer event.
    const previous = eventQueues.get(queueKey) ?? Promise.resolve();
    const run = previous
      .catch(() => {})
      .then(() => handleLayerEvent(event, yorishiroHome, deps, { invoke, convertFileSrc }))
      .catch((err) => {
        deps.userPackLog.write({
          phase: "reload",
          note: `watch event failed for '${event.path}'`,
          data: { error: errorMessage(err) },
        });
      });
    let queued!: Promise<void>;
    queued = run.finally(() => {
      if (eventQueues.get(queueKey) === queued) eventQueues.delete(queueKey);
    });
    eventQueues.set(queueKey, queued);
  };
  channel.onmessage = (event) => {
    const action = mapEventToAction(event, yorishiroHome);

    if (
      deps.packReloadEnabled !== false &&
      action.type === "remove-pack" &&
      action.kind === "ambient-ui"
    ) {
      const pending = pendingAmbientUiRemovals.get(action.id);
      if (pending !== undefined) clearTimeout(pending);
      // Atomic-save の create が来るまで旧 registration を残す。create 側の import /
      // validation が失敗しても旧版を失わない。create が来なければ通常削除へ収束する。
      const timeout = setTimeout(() => {
        pendingAmbientUiRemovals.delete(action.id);
        enqueueEvent(event, action);
      }, AMBIENT_UI_REMOVE_GRACE_MS);
      pendingAmbientUiRemovals.set(action.id, timeout);
      return;
    }

    if (action.type === "reload-pack" && action.kind === "ambient-ui") {
      const pending = pendingAmbientUiRemovals.get(action.id);
      if (pending !== undefined) {
        clearTimeout(pending);
        pendingAmbientUiRemovals.delete(action.id);
      }
    }

    enqueueEvent(event, action);
  };

  try {
    await invoke("watch_yorishiro_layer", { onEvent: channel });
    deps.userPackLog.write({
      phase: "watch",
      note: `watching ${yorishiroHome}`,
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
  event: YorishiroLayerEvent,
  yorishiroHome: string,
  deps: StartPackWatcherDeps,
  tauri: TauriBindings,
): Promise<void> {
  const action = mapEventToAction(event, yorishiroHome);

  if (
    deps.packReloadEnabled === false &&
    (action.type === "reload-pack" ||
      action.type === "reload-pack-source" ||
      action.type === "remove-pack")
  ) {
    return;
  }

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

    case "reload-pack-source":
      await reloadPackSourceOwners(action, deps, tauri);
      return;
  }
}

async function reloadPackSourceOwners(
  action: Extract<WatcherAction, { type: "reload-pack-source" }>,
  deps: StartPackWatcherDeps,
  tauri: TauriBindings,
): Promise<void> {
  let entries: UserPackEntry[];
  try {
    entries = await tauri.invoke<UserPackEntry[]>("list_user_packs");
  } catch (err) {
    deps.userPackLog.write({
      phase: "reload",
      note: `failed to resolve TSX owner for nested source in '${action.id}'`,
      data: { sourcePath: action.sourcePath, error: errorMessage(err) },
    });
    return;
  }

  const owners = entries.filter(
    (entry) => entry.id === action.id && entry.entryPath.endsWith(".tsx"),
  );
  if (owners.length === 0) {
    deps.userPackLog.write({
      phase: "reload",
      note: `nested source changed for '${action.id}', but no runtime-transpiled TSX owner was found`,
      data: { sourcePath: action.sourcePath },
    });
    return;
  }

  for (const owner of owners) {
    await reloadPack(
      {
        type: "reload-pack",
        id: owner.id,
        kind: owner.kind,
        entryPath: owner.entryPath,
        mtimeMs: action.mtimeMs,
      },
      deps,
      tauri,
    );
  }
}

/**
 * init.js の変更を hot reload に落とす。`initReload` が無いときは fallback の
 * log + marker 表示に劣化させ、safe mode / legacy 経路でも壊れないようにする。
 */
async function handleInitChanged(
  action: Extract<WatcherAction, { type: "init-changed" }>,
  deps: StartPackWatcherDeps,
): Promise<void> {
  if (deps.initReload === undefined) {
    deps.initScriptLog.write({
      phase: "reload",
      note: "init.js changed; hot reload unavailable for this session",
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
  const policyError = validatePackExecutionPolicy(
    {
      id: action.id,
      kind: action.kind,
      entryPath: action.entryPath,
      source: "local",
      manifest,
    },
    deps.executionEnvironment,
  );
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
          yorishiroVersion: "*",
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
      const existingManifest = deps.uiPackRegistry
        .listEntries()
        .find((entry) => entry.id === pack.id)?.manifest;
      deps.packRegistry.dispose(action.id, action.kind);
      const handle = deps.uiPackRegistry.register({
        id: pack.id,
        manifest: existingManifest ?? {
          id: pack.id,
          type: "ui",
          version: "0.0.0",
          yorishiroVersion: "*",
          entry: userPackEntryFilename(action.entryPath),
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
      if (pack.id !== action.id) {
        throw new Error(
          `ambient-ui id '${pack.id}' does not match containing pack id '${action.id}'`,
        );
      }
      const replaced = deps.packRegistry.has(action.id, action.kind);
      // register(new) -> track(new) の順なら、UserPackRegistry が旧 handle を
      // dispose しても AmbientUiPackRegistry の stale-handle guard が新 entry を守る。
      // import / validation はここより前なので、それらの失敗時は旧版が残る。
      const handle = deps.ambientUiPackRegistry.register({
        id: pack.id,
        origin: "user",
        manifest: {
          id: pack.id,
          type: "ambient-ui",
          version: "0.0.0",
          yorishiroVersion: "*",
          entry: userPackEntryFilename(action.entryPath),
        },
        pack: { mount: pack.mount },
      });
      deps.packRegistry.register(action.id, action.kind, handle);
      try {
        await deps.onAmbientUiRegistered?.({ id: pack.id, replaced });
      } catch (err) {
        // Activation reconciliation の failure で、正常に差し替えた registration
        // まで failed 扱いにしない。active set は callback 側の責務で不変に保つ。
        deps.userPackLog.write({
          phase: "reload",
          note: `ambient-ui activation reconciliation failed for '${pack.id}'`,
          data: { error: errorMessage(err) },
        });
      }
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
