import type {
  AmbientUiContext,
  Disposable,
  Trigger,
  TweenAPI,
  UiClaimAPI,
  UiContext,
  UiLayout,
  UiPackManifest,
  UiSceneLayerPatch,
  UiSceneLayerTarget,
  UiThreeAPI,
} from "@charminal/sdk";
import { Leva } from "leva";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDomClient from "react-dom/client";
import cameraMovePack from "../bundled-packs/effects/camera-move/effect";
import desaturatePack from "../bundled-packs/effects/desaturate/effect";
import fireworksPack from "../bundled-packs/effects/fireworks/effect";
import fireworksVolleyPack from "../bundled-packs/effects/fireworks-volley/effect";
import screenShakePack from "../bundled-packs/effects/screen-shake/effect";
import textPhysicsPack from "../bundled-packs/effects/text-physics/effect";
import claiManifest from "../bundled-packs/personas/clai/manifest.json";
import claiPack from "../bundled-packs/personas/clai/persona";
import abandonedFactoryManifest from "../bundled-packs/scenes/abandoned-factory/manifest.json";
import abandonedFactoryPack from "../bundled-packs/scenes/abandoned-factory/scene";
import mistyGrasslandsManifest from "../bundled-packs/scenes/misty-grasslands/manifest.json";
import mistyGrasslandsPack from "../bundled-packs/scenes/misty-grasslands/scene";
import simpleRoomManifest from "../bundled-packs/scenes/simple-room/manifest.json";
import simpleRoomPack from "../bundled-packs/scenes/simple-room/scene";
import charminalSettingsManifest from "../bundled-packs/ui/charminal-settings/manifest.json";
import charminalSettingsPack, {
  PREVIOUS_ACTIVE_UI_KEY,
  resolveCloseTarget,
  SETTINGS_PACK_ID,
} from "../bundled-packs/ui/charminal-settings/ui";
import { type SpawnSpec, sessionList } from "./bindings/tauri-commands";
import TabIndicator from "./components/TabIndicator";
import type { Body, EyeState } from "./core/body";
import { createSubsystemLog, DevLog, type DevLogEntry } from "./core/dev-log";
import { collectGlobalPrompt } from "./core/global-prompt";
import { registerEnvironmentFragment } from "./core/global-prompt/environment-fragment";
import { registerJournalFragment } from "./core/global-prompt/journal-fragment";
import { createLogAPI, LogBridge } from "./core/log-bridge";
import { Perception } from "./core/perception";
import type { Layer, LayerRole, SceneSpec } from "./core/scene";
import { registerSceneLayerBridge } from "./core/scene/scene-layer-bridge";
import { EffectDispatcher, EffectPackRunner, Renderer } from "./core/space";
import { Time } from "./core/time";
import { applyLayout, type LayoutTargets, resetLayout } from "./core/ui-layout";
import { type AmbientAudioRuntime, initAmbientAudio } from "./runtime/ambient-audio";
import { getAmbientUiPackRegistry } from "./runtime/ambient-ui-pack-registry";
import {
  startDevAttentionProducer,
  startFocusedDomAttentionProducer,
  startInputCursorAttentionProducer,
  startMcpAttentionProducer,
  startMouseAttentionProducer,
  startTerminalAttentionProducer,
  startToolAttentionProducer,
} from "./runtime/attention-producers";
import { getAttentionRuntime } from "./runtime/attention-runtime";
import { registerBundledAttentionAura } from "./runtime/bundled-attention-aura";
import { EventBus, type EventBusLogger } from "./runtime/event-bus";
import { getOrInit } from "./runtime/hot-data";
import { getModuleRegistry, KEYS } from "./runtime/module-registry";
import { PersonaReflexDispatcher } from "./runtime/persona-reflex";
import type { PersonaEntry } from "./runtime/persona-registry";
import {
  createRealPersonaContextFactory,
  createStubPersonaContextFactory,
  getPersonaRegistry,
} from "./runtime/persona-registry";
import {
  getSceneRegistry,
  resolveSceneAssets,
  type ScenePackEntry,
  type ScenePackRegistry,
} from "./runtime/scene-pack-registry";
import type { SessionTabState } from "./runtime/session-tabs";
import { installTabKeybindings, SessionTabManager } from "./runtime/session-tabs";
import { DEFAULT_SESSION_ID, resolveProfile } from "./runtime/sessions";
import { DEFAULT_TERMINAL_THEME, getTerminalRuntime } from "./runtime/terminal-runtime";
import { initTerminalTheme } from "./runtime/terminal-theme";
import { getThreeRuntime } from "./runtime/three-runtime";
import { getClaimState } from "./runtime/ui-claim-state";
import { getUiRegistry, type UiPackEntry } from "./runtime/ui-pack-registry";
import { getUiStateStore } from "./runtime/ui-state-store";
import { loadUserLayer, UserPackRegistry } from "./runtime/user-pack-loader";
import {
  readCharminalConfigText,
  writeCharminalConfigText,
} from "./runtime/user-pack-loader/charminal-io";
import {
  parseConfig,
  serializeConfig,
  type TerminalAgent,
  withActiveAmbientUiSet,
} from "./runtime/user-pack-loader/config";
import type { PersonaDefinition } from "./sdk/persona";
import type { PersonaPackManifest } from "./sdk/persona-pack";
import type { ScenePackDefinition, ScenePackManifest } from "./sdk/scene-pack";
import Sidebar from "./sidebar";
import Terminal from "./terminal";
import "./App.css";

function mergeSystemPromptParts(
  personaAddition: string | null | undefined,
  globalPrompt: string | null,
): string | null {
  const persona = personaAddition?.trim() || null;

  if (!globalPrompt && !persona) return null;
  if (!globalPrompt) return persona;
  if (!persona) return globalPrompt;
  return `${persona}\n\n---\n\n${globalPrompt}`;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  fallback: T,
  onTimeout: () => void,
): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<T>((resolve) => {
    timeoutId = setTimeout(() => {
      timeoutId = null;
      onTimeout();
      resolve(fallback);
    }, timeoutMs);
  });
  const result = await Promise.race([promise, timeout]);
  if (timeoutId !== null) clearTimeout(timeoutId);
  return result;
}

const CWD_STORAGE_KEY = "charminal:cwd";
const ACTIVE_SESSION_STORAGE_KEY = "charminal:active-session";
const VRM_STORAGE_KEY = "charminal:vrm";

type SceneLayerOverride = {
  readonly target: UiSceneLayerTarget;
  readonly patch: UiSceneLayerPatch;
};

type MutableLayer = {
  id: string;
  role?: LayerRole;
  src?: string;
  mediaType?: "image" | "video";
  procedural?: Layer["procedural"];
  backgroundColor?: string;
  backgroundImage?: string;
  blur?: number;
  opacity?: number;
};

function sceneLayerTargetKey(target: UiSceneLayerTarget): string | null {
  if (typeof target.role === "string") return `role:${target.role}`;
  if (typeof target.id === "string" && target.id.length > 0) return `id:${target.id}`;
  return null;
}

function sceneLayerMatchesTarget(layer: Layer, target: UiSceneLayerTarget): boolean {
  if (target.role !== undefined) return layer.role === target.role;
  if (target.id !== undefined) return layer.id === target.id;
  return false;
}

function applySceneLayerPatch(layer: Layer, patch: UiSceneLayerPatch): Layer {
  const next: MutableLayer = { ...layer };
  if ("src" in patch) {
    if (patch.src === null) {
      delete next.src;
    } else if (patch.src !== undefined) {
      next.src = patch.src;
      delete next.procedural;
    }
  }
  if ("mediaType" in patch) {
    if (patch.mediaType === null) {
      delete next.mediaType;
    } else if (patch.mediaType !== undefined) {
      next.mediaType = patch.mediaType;
    }
  }
  if ("backgroundColor" in patch) {
    if (patch.backgroundColor === null) {
      delete next.backgroundColor;
    } else if (patch.backgroundColor !== undefined) {
      next.backgroundColor = patch.backgroundColor;
    }
  }
  if ("backgroundImage" in patch) {
    if (patch.backgroundImage === null) {
      delete next.backgroundImage;
    } else if (patch.backgroundImage !== undefined) {
      next.backgroundImage = patch.backgroundImage;
    }
  }
  if ("blur" in patch) {
    if (patch.blur === null) {
      delete next.blur;
    } else if (patch.blur !== undefined) {
      next.blur = patch.blur;
    }
  }
  if ("opacity" in patch) {
    if (patch.opacity === null) {
      delete next.opacity;
    } else if (patch.opacity !== undefined) {
      next.opacity = patch.opacity;
    }
  }
  return next;
}

function createSceneLayerForTarget(target: UiSceneLayerTarget): Layer | null {
  if (target.role === "background") return { id: "ui-background", role: "background" };
  if (target.role === "foreground") return { id: "ui-foreground", role: "foreground" };
  if (target.id !== undefined && target.id.length > 0) return { id: target.id };
  return null;
}

function insertSceneLayer(layers: ReadonlyArray<Layer>, layer: Layer): ReadonlyArray<Layer> {
  if (layer.role === "background") {
    const characterIndex = layers.findIndex((candidate) => candidate.role === "character");
    if (characterIndex >= 0) {
      return [...layers.slice(0, characterIndex), layer, ...layers.slice(characterIndex)];
    }
    return [layer, ...layers];
  }
  return [...layers, layer];
}

function applySceneLayerOverride(scene: SceneSpec, override: SceneLayerOverride): SceneSpec {
  let found = false;
  const layers = scene.layers.map((layer) => {
    if (!sceneLayerMatchesTarget(layer, override.target)) return layer;
    found = true;
    return applySceneLayerPatch(layer, override.patch);
  });
  if (found) return { ...scene, layers };

  const created = createSceneLayerForTarget(override.target);
  if (created === null) return scene;
  return {
    ...scene,
    layers: insertSceneLayer(layers, applySceneLayerPatch(created, override.patch)),
  };
}

function applySceneLayerOverrides(
  scene: SceneSpec | null,
  overrides: ReadonlyArray<SceneLayerOverride>,
): SceneSpec | null {
  if (scene === null || overrides.length === 0) return scene;
  return overrides.reduce((next, override) => applySceneLayerOverride(next, override), scene);
}

function upsertSceneLayerOverride(
  overrides: ReadonlyArray<SceneLayerOverride>,
  target: UiSceneLayerTarget,
  patch: UiSceneLayerPatch,
): ReadonlyArray<SceneLayerOverride> {
  const key = sceneLayerTargetKey(target);
  if (key === null) return overrides;
  const next = [...overrides];
  const index = next.findIndex((override) => sceneLayerTargetKey(override.target) === key);
  if (index >= 0) {
    next[index] = { target, patch: { ...next[index].patch, ...patch } };
  } else {
    next.push({ target, patch });
  }
  return next;
}

function removeSceneLayerOverride(
  overrides: ReadonlyArray<SceneLayerOverride>,
  target: UiSceneLayerTarget,
): ReadonlyArray<SceneLayerOverride> {
  const key = sceneLayerTargetKey(target);
  if (key === null) return overrides;
  return overrides.filter((override) => sceneLayerTargetKey(override.target) !== key);
}

declare global {
  var __CHARMINAL_REACT__: typeof React | undefined;
  var __CHARMINAL_REACT_DOM_CLIENT__: typeof ReactDomClient | undefined;
  var __CHARMINAL_REACT_JSX_RUNTIME__: typeof ReactJsxRuntime | undefined;
}

globalThis.__CHARMINAL_REACT__ = React;
globalThis.__CHARMINAL_REACT_DOM_CLIENT__ = ReactDomClient;
globalThis.__CHARMINAL_REACT_JSX_RUNTIME__ = ReactJsxRuntime;

function App() {
  // ── State placement rule ────────────────────────────────────
  // 5 種類の置き場が混在する。**何を入れるかで決める**：
  //   useState        : UI が直接読む / mount/unmount に追従させたい React state（cwd, vrmPath, isUserLayerReady, activeScene, primaryPersona, vrmUrl）
  //   useRef          : render を起こさない mutable cell（bodyRef, greetedRef, inTurnRef）
  //   useMemo         : derive が安いが ref-stable に保ちたい view-side compute（bodyDevLog, folderName）
  //   hot-data        : HMR 越しに 1 instance のみ生かしたい runtime singleton（runtime stack 全体、各 registry）
  //   module-registry : 各 trigger / swap-in module の registry（getModuleRegistry()）
  // 詳細: src/runtime/README.md §HMR と singleton

  const [cwd] = useState<string | null>(() => localStorage.getItem(CWD_STORAGE_KEY));
  const [vrmPath, setVrmPath] = useState<string | null>(() =>
    localStorage.getItem(VRM_STORAGE_KEY),
  );

  // ── Runtime stack (HMR-surviving singleton) ─────────────────

  const runtime = getOrInit("app:runtime", () => {
    const time = new Time();
    const logger: EventBusLogger = {
      warn: (msg, meta) => console.warn(`[charminal] ${msg}`, meta),
      error: (msg, meta) => console.error(`[charminal] ${msg}`, meta),
    };
    // Generation-time 細い回路 — dev でのみ active、console に mirror して即時視認。
    // Philosophy: docs/philosophy/CHARMINAL.md「ログという細い回路（生成期の sibling）」.
    const devLog = new DevLog({
      time,
      enabled: import.meta.env.DEV,
      sink: (entry: DevLogEntry) => {
        const tag = entry.phase ? `${entry.subsystem}:${entry.phase}` : entry.subsystem;
        console.log(`[${tag}] ${entry.note ?? ""}`, entry.data ?? "");
      },
    });
    const bus = new EventBus({
      time,
      logger,
      devLog: createSubsystemLog(devLog, "EventBus"),
    });
    const logBridge = new LogBridge({ time });
    // ── グローバル system prompt フラグメント登録 ────────────────────────
    registerEnvironmentFragment();
    registerJournalFragment();
    const globalPromptPromise = collectGlobalPrompt();

    const effectDispatcher = new EffectDispatcher();
    const claimState = getClaimState();
    // Effect Pack infrastructure. screen-shake は body に transform を当てる
    // ことで fixed 子孫（three-runtime の canvas container）も含めて一緒に
    // 揺らす（body の transform は fixed 子孫の containing block を作る）。
    const renderer = new Renderer({
      shakeTarget: document.body,
      terminalCellExtractor: () => getTerminalRuntime(DEFAULT_SESSION_ID).extractVisibleCells(),
      camera: {
        claim: () => claimState.claim("camera"),
        getState: () => {
          const camera = getThreeRuntime().getCamera();
          return {
            x: camera.position.x,
            y: camera.position.y,
            z: camera.position.z,
            fov: camera.fov,
          };
        },
        applyState: (state, lookAt) => {
          const camera = getThreeRuntime().getCamera();
          camera.position.set(state.x, state.y, state.z);
          camera.fov = state.fov;
          camera.updateProjectionMatrix();
          camera.lookAt(lookAt?.x ?? 0, lookAt?.y ?? state.y, lookAt?.z ?? 0);
        },
      },
    });
    const effectPackRunner = new EffectPackRunner({
      dispatcher: effectDispatcher,
      renderer,
      time,
    });
    effectPackRunner.register(screenShakePack);
    effectPackRunner.register(fireworksPack);
    effectPackRunner.register(fireworksVolleyPack);
    effectPackRunner.register(textPhysicsPack);
    effectPackRunner.register(desaturatePack);
    effectPackRunner.register(cameraMovePack);

    // Presence の hook callback は presence-intensity module が dynamic import される
    // 後でしか buildPresenceDeps が組めないため、ref で late-bind する。
    // bind 完了前に hook が発火しても no-op で安全側に倒れる。
    const presenceRestoreRef: { current: () => void } = { current: () => {} };

    const perception = new Perception({
      bus,
      time,
      devLog: createSubsystemLog(devLog, "Perception"),
      onPresenceRestore: () => presenceRestoreRef.current(),
    });

    // Scene pack registry — HMR singleton（KEYS.SCENE_PACK_REGISTRY で共有）。
    const scenePackRegistry: ScenePackRegistry = getSceneRegistry();

    // UI pack registry — HMR singleton（KEYS.UI_PACK_REGISTRY で共有）。
    const uiPackRegistry = getUiRegistry();
    const uiState = getUiStateStore();

    // ── PersonaRegistryImpl への bundled persona 登録 ────────────────────────
    // PersonaRegistryImpl は state management（active persona / subscribeActive）。
    // bundled clai を sync register する。ここを async にすると
    // 初期 render で getActivePersona() が null を返し、Terminal が systemPrompt=null
    // で spawn → async 完了後に再 spawn、という race が起きる。
    // bundled pack は static import 済なので register は同期で確定する。
    // config.primaryPersona 反映だけ async（file I/O を伴うため）。
    // （memory: feedback_dev_verification_not_enough.md）。
    const appLog = createSubsystemLog(devLog, "App");
    const personaRegistry = getPersonaRegistry();
    personaRegistry.register({
      id: claiPack.id,
      manifest: claiManifest as PersonaPackManifest,
      persona: claiPack,
      origin: "bundled",
    } satisfies PersonaEntry);
    appLog.write({
      phase: "register",
      note: `registered bundled persona '${claiPack.id}'`,
    });

    // bundled charminal-settings UI pack。
    uiPackRegistry.register({
      id: charminalSettingsPack.id,
      origin: "bundled",
      manifest: charminalSettingsManifest as UiPackManifest,
      pack: {
        layout: charminalSettingsPack.layout,
        mount: charminalSettingsPack.mount,
      },
    });
    appLog.write({
      phase: "register",
      note: `registered bundled UI pack '${charminalSettingsPack.id}'`,
    });

    // ── PersonaReflexDispatcher を構築 ───────────────────────────────────────
    // active persona の reflex（customTriggers + responses）を EventBus に bridge する。
    // subscribeActive は登録時に現 active を同期 fire するので、bundled persona の
    // triggers が dispatcher 構築と同時に bus に attach される。user pack が後から
    // register された場合も、subscribeActive 経由で dispatcher が反応し trigger を
    // 付け替える（user pack の reflex がここで初めて動くようになる）。
    // Internal design-record: 2026-04-19-persona-registry-unification.md
    const dispatcher = new PersonaReflexDispatcher({
      bus,
      time,
      registry: personaRegistry,
      logger,
    });

    // ── Bundled ambient-UI pack 登録（attention-aura）────────────────────────
    // bootstrap より前に register しておくことで、Step 2 の config 読み込み後に
    // registry.enable() を呼んでも「unknown id」警告が出ない。
    const ambientUiRegistry = getAmbientUiPackRegistry();
    registerBundledAttentionAura({ registry: ambientUiRegistry });
    appLog.write({
      phase: "register",
      note: "registered bundled ambient-UI pack 'attention-aura'",
    });

    // ── User layer 準備 (bootstrap) ───────────────────────────────────────
    // 旧来は 3 つの fire-and-forget IIFE で並行実行していたが、互いに strict な
    // 順序依存（bundled scene → config 反映 → user pack load）があり race で
    // 隠れバグを生みやすかった。1 つの async bootstrap に集約し、step ごとに
    // 独立した try/catch + appLog で片方の失敗が他方を巻き込まない構造に。
    // 読者は「Terminal が mount するまでに何が起きるか」をこの関数の上から下に
    // 追えば把握できる。

    const packRegistry = new UserPackRegistry({
      log: createSubsystemLog(devLog, "UserPackRegistry"),
    });
    // userLayerReady は Terminal mount を gate する Promise。
    // **Step 3 完了直後** に resolve する（systemPrompt の race / 多重 spawn 回避）。
    // defaultSpec は config.defaultProfile が shell profile を指していたときに
    // 構築される SpawnSpec.Shell。null なら従来の terminalAgent fallback で動く。
    let userLayerReadyResolve!: (init: {
      terminalAgent: TerminalAgent;
      defaultSpec: SpawnSpec | null;
      systemPrompt: string | null;
    }) => void;
    const userLayerReady = new Promise<{
      terminalAgent: TerminalAgent;
      defaultSpec: SpawnSpec | null;
      systemPrompt: string | null;
    }>((resolve) => {
      userLayerReadyResolve = resolve;
    });

    async function bootstrap(): Promise<void> {
      // ─ Step 1: bundled scene の asset を resolve して register（async：asset 解決） ─
      try {
        const bundledScenes: ReadonlyArray<{
          readonly pack: ScenePackDefinition;
          readonly manifest: ScenePackManifest;
        }> = [
          { pack: simpleRoomPack, manifest: simpleRoomManifest as ScenePackManifest },
          { pack: mistyGrasslandsPack, manifest: mistyGrasslandsManifest as ScenePackManifest },
          { pack: abandonedFactoryPack, manifest: abandonedFactoryManifest as ScenePackManifest },
        ];
        for (const { pack, manifest } of bundledScenes) {
          const resolved = await resolveSceneAssets(pack.scene, {
            origin: "bundled",
            packId: pack.id,
            onMissing: (assetKey, src) => {
              appLog.write({
                phase: "register",
                note: `bundled scene "${pack.id}": asset missing for layer "${assetKey}" (src="${src}")`,
              });
            },
          });
          scenePackRegistry.register({
            id: pack.id,
            manifest,
            scene: resolved,
            origin: "bundled",
            component: pack.component,
          });
          appLog.write({
            phase: "register",
            note: `registered bundled scene '${pack.id}'`,
          });
        }
      } catch (err) {
        appLog.write({
          phase: "register",
          note: "bundled scene register failed",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      // ─ Step 2: config を一度だけ読んで primaryPersona と activeScene を反映 ─
      // 旧設計は IIFE 2 つで個別に config を読んでいたが、同じ file を 2 度 parse
      // していた。1 回読み + 両 registry に流す。失敗しても次 step は続行
      // （bundled fallback で動く）。
      let terminalAgent: TerminalAgent = "claude";
      let defaultSpec: SpawnSpec | null = null;
      let ambientAudioMuted = false;
      let ambientAudioVolume = 1.0;
      try {
        const configText = await readCharminalConfigText();
        const config = parseConfig(configText);
        terminalAgent = config.terminalAgent;
        ambientAudioMuted = config.ambientAudioMuted;
        ambientAudioVolume = config.ambientAudioVolume;
        // defaultProfile が shell profile を指していたら shell spec を build。
        // agent profile を指している場合は Phase B-1 では terminalAgent fallback で動く
        // （Phase C で agent profile も defaultProfile から resolve できるようにする）。
        if (config.defaultProfile !== null) {
          const profile = resolveProfile(config.defaultProfile, config.profiles);
          if (profile?.kind === "shell") {
            defaultSpec = {
              kind: "shell",
              command: profile.command,
              integration: profile.integration,
            };
          }
        }
        personaRegistry.setPrimaryPersona(config.primaryPersona);
        scenePackRegistry.setActiveScene(config.activeScene);
        uiPackRegistry.setActiveUi(config.activeUi);
        for (const id of config.activeAmbientUi) {
          getAmbientUiPackRegistry().enable(id);
        }
      } catch (err) {
        appLog.write({
          phase: "register",
          note: "config read for primaryPersona / activeScene failed",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      // ─ Step 2.5: subscribeActive 系 wire ─
      // config 反映後に subscribe することで、bundled fallback の alphabetical 先頭
      // （abandoned-factory）が一瞬 active 扱いになって音が鳴る race を回避する。
      ambientAudioEngineRef.current = initAmbientAudio(scenePackRegistry).engine;
      ambientAudioEngineRef.current.setMuted(ambientAudioMuted);
      ambientAudioEngineRef.current.setMasterVolume(ambientAudioVolume);
      appLog.write({
        phase: "register",
        note: "initialized AmbientAudioRuntime",
      });
      initTerminalTheme(scenePackRegistry);
      appLog.write({
        phase: "register",
        note: "initialized terminal theme wire",
      });

      // ─ Step 3: user layer load（user pack register、init.js 実行）─
      // user layer は Terminal 起動の critical path に置かない。短い grace period 内に
      // 完了すれば user persona も初回 prompt に入るが、pack import / watcher が詰まっても
      // bundled fallback で Terminal mount と agent spawn を進める。
      const userLayerPromise = (async (): Promise<Awaited<
        ReturnType<typeof loadUserLayer>
      > | null> => {
        try {
          const result = await loadUserLayer({
            effectPackRunner,
            personaRegistry,
            scenePackRegistry,
            uiPackRegistry,
            ambientUiPackRegistry: getAmbientUiPackRegistry(),
            effectDispatcher,
            emitEvent: (name, payload) => {
              bus.emitSynthetic({ type: "utility", packId: "user-init" }, name, payload, 0);
            },
            packRegistry,
            personaDefaults: claiPack,
            userPackLog: createSubsystemLog(devLog, "UserPackLoader"),
            initScriptLog: createSubsystemLog(devLog, "InitScript"),
            tweenManager: getThreeRuntime().getTweenManager(),
          });
          appLog.write({
            phase: "user-layer",
            note: `user-layer ready (packs loaded=${result.packs.loaded.length} failed=${result.packs.failed.length}; init ran=${result.init.ran})`,
            data: { packs: result.packs, init: result.init },
          });
          return result;
        } catch (err) {
          appLog.write({
            phase: "user-layer",
            note: "user-layer bootstrap crashed",
            data: { error: err instanceof Error ? err.message : String(err) },
          });
          return null;
        }
      })();

      const [userLayerResult, globalPrompt] = await Promise.all([
        withTimeout(userLayerPromise, 1200, null, () => {
          appLog.write({
            phase: "user-layer",
            note: "user-layer load timed out; starting terminal with current persona",
          });
        }),
        withTimeout(globalPromptPromise, 1200, null, () => {
          appLog.write({
            phase: "global-prompt",
            note: "global prompt collection timed out; starting terminal without global prompt",
          });
        }),
      ]);
      const safeMode = userLayerResult?.safeMode ?? false;
      const systemPrompt = mergeSystemPromptParts(
        personaRegistry.getActivePersona()?.thinking?.systemPromptAddition,
        globalPrompt,
      );

      // ★ Terminal mount 解禁。user layer が grace period 内に終わらなくても、現在
      //   active な persona（少なくとも bundled fallback）で agent spawn を始める。
      //   以下 step は Terminal とは独立に走るので、失敗しても Terminal の表示は止まらない。
      userLayerReadyResolve({ terminalAgent, defaultSpec, systemPrompt });

      // ─ Step 4: safe mode のとき window title に suffix（独立な失敗で MCP に影響しない）─
      // user が env var で safe mode に入ったことを常時 visible にする。
      if (safeMode) {
        try {
          const { getCurrentWindow } = await import("@tauri-apps/api/window");
          const win = getCurrentWindow();
          const current = await win.title();
          if (!current.endsWith(" (Safe Mode)")) {
            await win.setTitle(`${current} (Safe Mode)`);
          }
        } catch (err) {
          appLog.write({
            phase: "safe-mode-title",
            note: "failed to append Safe Mode suffix to window title",
            data: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      // ─ Step 5: MCP event channel wiring ─
      // Rust 側 MCP server が tool call を受けると `mcp:tool-request` event を emit、
      // TS 側で対応 handler を走らせ `mcp_tool_response` command で response を戻す。
      // Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.5
      try {
        const { listen } = await import("@tauri-apps/api/event");
        const { invoke } = await import("@tauri-apps/api/core");
        const { dispatchToolEvent } = await import("./runtime/charminal-mcp/event-channel");
        const {
          createListPacksHandler,
          createDisablePackHandler,
          createEnablePackHandler,
          createGetPackStateHandler,
          createSetPackStateHandler,
          // Phase β cosmetic write tools：
          createStateGetHandler,
          createBodyExpressionSetHandler,
          createSpaceEffectPlayHandler,
          createSceneCameraSetHandler,
          createSceneLightingSetHandler,
          // Phase γ motion tools：
          createBodyAnimationPlayHandler,
          createBodyMotionCancelHandler,
          // UI tween tools：
          createUiSceneLayerSetHandler,
          createUiTerminalSetHandler,
          createUiSidebarSetHandler,
          createUiDebugPanelSetHandler,
          // Phase: active pack switching
          createSceneActivateHandler,
          createUiActivateHandler,
          // Camera modulation
          createSceneCameraModulationHandler,
          // Screenshot:
          createSceneScreenshotHandler,
          // Presence intensity:
          createPresenceSetIntensityHandler,
        } = await import("./runtime/charminal-mcp/tool-handlers");
        const { applyPresenceLevel, getPresenceSnapshot, onUserPromptSubmit } = await import(
          "./runtime/presence-intensity"
        );
        type PresenceIntensityDeps = import("./runtime/presence-intensity").PresenceIntensityDeps;
        const { writeCharminalConfigText, readLastStartupReport } = await import(
          "./runtime/user-pack-loader/charminal-io"
        );
        const { serializeConfig } = await import("./runtime/user-pack-loader/config");
        const { reloadSingleUserPack } = await import("./runtime/user-pack-loader/runtime-wire");
        type CharminalConfig = import("./runtime/user-pack-loader/config").CharminalConfig;
        type LoadReport = import("./runtime/user-pack-loader/load-report").LoadReport;
        type ToolHandlerMap = import("./runtime/charminal-mcp/event-channel").ToolHandlerMap;

        const readConfig = async (): Promise<CharminalConfig> =>
          parseConfig(await readCharminalConfigText());
        const writeConfig = async (next: CharminalConfig): Promise<void> =>
          writeCharminalConfigText(serializeConfig(next));
        const readLoadReport = async (): Promise<LoadReport | null> => {
          const text = await readLastStartupReport();
          if (text === "") return null;
          try {
            return JSON.parse(text) as LoadReport;
          } catch {
            return null;
          }
        };
        // disable/enable で fs から読み直して runtime registry に register し直す経路。
        // Presence Intensity の deps factory。MCP handler / idle fallback / restore
        // 全てここを経由する。getThreeRuntime / getAmbientUiPackRegistry は singleton
        // なので呼び出しのたびに最新の instance を引ける。
        const buildPresenceDeps = (): PresenceIntensityDeps => ({
          setSidebarWidth: (px) => {
            document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
            const el = document.querySelector<HTMLElement>(".sidebar");
            if (el) el.classList.toggle("presence-closed", px <= 0);
          },
          getSidebarWidth: () => {
            const raw = getComputedStyle(document.documentElement)
              .getPropertyValue("--sidebar-width")
              .trim();
            const n = Number.parseFloat(raw);
            // 0 は valid な現在値（closed 状態）。NaN のときだけ default に倒す。
            return Number.isNaN(n) ? 280 : n;
          },
          // App.css の :root --sidebar-width 初期値（280px）と一致させる。
          getDefaultSidebarWidth: () => 280,
          tweenManager: getThreeRuntime().getTweenManager(),
          ambientUiRegistry: getAmbientUiPackRegistry(),
          setRenderPaused: (paused) => getThreeRuntime().setRenderPaused(paused),
          now: () => Date.now(),
        });

        const userPackLog = createSubsystemLog(devLog, "UserPackLoader");
        const reloadPack = async (id: string): Promise<{ ok: boolean; reason?: string }> => {
          return reloadSingleUserPack(id, {
            effectPackRunner,
            personaRegistry,
            scenePackRegistry,
            uiPackRegistry,
            ambientUiPackRegistry: getAmbientUiPackRegistry(),
            packRegistry,
            userPackLog,
          });
        };

        const handlers: ToolHandlerMap = {
          "list-packs": createListPacksHandler({
            readRegistry: () => packRegistry.listEntries(),
            readBundledPacks: () => [
              ...personaRegistry
                .listEntries()
                .filter((e) => e.origin === "bundled")
                .map((e) => ({ id: e.id, kind: "persona" })),
              ...scenePackRegistry
                .listEntries()
                .filter((e) => e.origin === "bundled")
                .map((e) => ({ id: e.id, kind: "scene" })),
              ...uiPackRegistry
                .listEntries()
                .filter((e) => e.origin === "bundled")
                .map((e) => ({ id: e.id, kind: "ui" })),
              ...[
                cameraMovePack,
                desaturatePack,
                fireworksPack,
                fireworksVolleyPack,
                screenShakePack,
                textPhysicsPack,
              ].map((p) => ({ id: p.id, kind: "effect" })),
            ],
            readConfig,
            readLoadReport,
            getActiveIds: () => ({
              scene: scenePackRegistry.getActiveSceneId(),
              ui: uiPackRegistry.getActiveUiId(),
              persona: personaRegistry.getActivePersonaId(),
            }),
          }),
          "disable-pack": createDisablePackHandler({
            readConfig,
            writeConfig,
            registry: packRegistry,
          }),
          "enable-pack": createEnablePackHandler({
            readConfig,
            writeConfig,
            reloadPack,
          }),
          "get-ui-state": createGetPackStateHandler({
            state: uiState,
          }),
          "set-ui-state": createSetPackStateHandler({
            state: uiState,
          }),
          // ── Phase β cosmetic write tools ────────────────────────
          "state.get": createStateGetHandler({
            readConfig,
            getCamera: () => getThreeRuntime().getCamera(),
            getScene: () => getThreeRuntime().getScene(),
            getVrm: () => getThreeRuntime().getVrm(),
            getBody: () => getThreeRuntime().getBody(),
            tweenManager: getThreeRuntime().getTweenManager(),
            getSidebarWidth: () => {
              const raw = getComputedStyle(document.documentElement)
                .getPropertyValue("--sidebar-width")
                .trim();
              return Number.parseFloat(raw) || 280;
            },
            getTerminalOpacity: () => {
              const el = document.querySelector<HTMLElement>(".xterm-singleton-container");
              if (!el) return 1;
              const raw = el.style.opacity;
              return raw === "" ? 1 : Number(raw);
            },
            getSceneLayerValues: (role) => {
              const scene = renderedSceneRef.current;
              if (!scene) return { blur: 0, opacity: 1 };
              const layer = scene.layers.find((l) => l.role === role);
              return { blur: layer?.blur ?? 0, opacity: layer?.opacity ?? 1 };
            },
            getCameraTracking: () => getThreeRuntime().getCameraTracking(),
            getCameraModulationState: () => {
              const mod = getThreeRuntime().getCameraModulation();
              return {
                enabled: mod.enabled,
                suspended: getThreeRuntime().isCameraModulationSuspended(),
                activeKeys: [...mod.activeKeys],
              };
            },
            getEffectKinds: () => effectDispatcher.getRegisteredKinds(),
            getRuntimeActive: () => ({
              scene: scenePackRegistry.getActiveSceneId(),
              ui: uiPackRegistry.getActiveUiId(),
            }),
            getPresenceSnapshot,
          }),
          "body.expression.set": createBodyExpressionSetHandler({
            getBody: () => getThreeRuntime().getBody(),
          }),
          "space.effect.play": createSpaceEffectPlayHandler({
            effectDispatcher,
          }),
          "scene.camera.set": createSceneCameraSetHandler({
            getCamera: () => getThreeRuntime().getCamera(),
            tweenManager: getThreeRuntime().getTweenManager(),
            claimCamera: () => claimState.claim("camera"),
            setCameraTracking: (enabled) => getThreeRuntime().setCameraTracking(enabled),
            getCameraTracking: () => getThreeRuntime().getCameraTracking(),
            setCameraBase: (pos) => getThreeRuntime().setCameraBase(pos[0], pos[1], pos[2]),
          }),
          "scene.lighting.set": createSceneLightingSetHandler({
            getScene: () => getThreeRuntime().getScene(),
            tweenManager: getThreeRuntime().getTweenManager(),
          }),
          // ── Phase γ motion tools ────────────────────────
          "body.animation.play": createBodyAnimationPlayHandler({
            getBody: () => getThreeRuntime().getBody(),
          }),
          "body.motion.cancel": createBodyMotionCancelHandler(),
          // ── UI tween tools ─────────────────────────────────
          "ui.scene-layer.set": createUiSceneLayerSetHandler({
            updateSceneLayer: (target, patch) => {
              setSceneLayerOverrides((prev) =>
                upsertSceneLayerOverride(prev, { role: target.role as LayerRole }, patch),
              );
            },
            getSceneLayerValues: (role) => {
              const scene = renderedSceneRef.current;
              if (!scene) return { blur: 0, opacity: 1 };
              const layer = scene.layers.find((l) => l.role === role);
              return {
                blur: layer?.blur ?? 0,
                opacity: layer?.opacity ?? 1,
              };
            },
            tweenManager: getThreeRuntime().getTweenManager(),
          }),
          "ui.terminal.set": createUiTerminalSetHandler({
            setTerminalOpacity: (value) => {
              const el = document.querySelector<HTMLElement>(".xterm-singleton-container");
              if (el) el.style.opacity = String(value);
            },
            getTerminalOpacity: () => {
              const el = document.querySelector<HTMLElement>(".xterm-singleton-container");
              if (!el) return 1;
              const raw = el.style.opacity;
              return raw === "" ? 1 : Number(raw);
            },
            tweenManager: getThreeRuntime().getTweenManager(),
          }),
          "ui.sidebar.set": createUiSidebarSetHandler({
            setSidebarWidth: (px) => {
              document.documentElement.style.setProperty("--sidebar-width", `${px}px`);
              const el = document.querySelector<HTMLElement>(".sidebar");
              if (el) el.classList.toggle("presence-closed", px <= 0);
            },
            getSidebarWidth: () => {
              const raw = getComputedStyle(document.documentElement)
                .getPropertyValue("--sidebar-width")
                .trim();
              return Number.parseFloat(raw) || 280;
            },
            getDefaultSidebarWidth: (() => {
              const raw = getComputedStyle(document.documentElement)
                .getPropertyValue("--sidebar-width")
                .trim();
              const initial = Number.parseFloat(raw) || 280;
              return () => initial;
            })(),
            getWindowSize: () => ({
              width: window.innerWidth,
              height: window.innerHeight,
            }),
            tweenManager: getThreeRuntime().getTweenManager(),
          }),
          "ui.debugPanel.set": createUiDebugPanelSetHandler({
            setDebugPanelWidth: (px) => {
              const w = Math.max(0, px);
              document.documentElement.style.setProperty("--leva-panel-width", `${w}px`);
              setLevaHidden(w <= 0);
            },
            getDebugPanelWidth: () => {
              const raw = getComputedStyle(document.documentElement)
                .getPropertyValue("--leva-panel-width")
                .trim();
              return Number.parseFloat(raw) || 0;
            },
            getDefaultDebugPanelWidth: () => 280,
            tweenManager: getThreeRuntime().getTweenManager(),
          }),
          // ── Active pack switching ──────────────────────────
          "scene.activate": createSceneActivateHandler({
            registry: scenePackRegistry,
          }),
          "ui.activate": createUiActivateHandler({
            registry: uiPackRegistry,
          }),
          // ── Camera modulation ─────────────────────────────
          "scene.camera.modulation": createSceneCameraModulationHandler({
            getCameraModulation: () => getThreeRuntime().getCameraModulation(),
            isCameraModulationSuspended: () => getThreeRuntime().isCameraModulationSuspended(),
          }),
          // ── Screenshot ────────────────────────────────────
          "scene.screenshot": createSceneScreenshotHandler({
            getCamera: () => getThreeRuntime().getCamera(),
            getScene: () => getThreeRuntime().getScene(),
            getRenderer: () => getThreeRuntime().getRenderer(),
            claimCamera: () => claimState.claim("camera"),
          }),
          // ── Presence intensity ────────────────────────────
          "presence.set-intensity": createPresenceSetIntensityHandler({
            applyPresenceLevel: (level, source) => {
              applyPresenceLevel(level, source, buildPresenceDeps());
            },
          }),
        };

        // Perception の presence callback を late-bind する。
        // Perception 構築時には presence-intensity module が dynamic import 前のため
        // ref で空 callback を埋めておき、ここで実体に差し替える。
        presenceRestoreRef.current = (): void => {
          onUserPromptSubmit(buildPresenceDeps());
        };

        await listen<{ requestId: string; tool: string; request: unknown }>(
          "mcp:tool-request",
          async (event) => {
            const result = await dispatchToolEvent(handlers, {
              tool: event.payload.tool,
              request: event.payload.request,
            });
            await invoke("mcp_tool_response", {
              requestId: event.payload.requestId,
              response: result,
            });
          },
        );
        appLog.write({
          phase: "mcp-channel",
          note: "mcp:tool-request listener attached",
        });
      } catch (err) {
        appLog.write({
          phase: "mcp-channel",
          note: "failed to attach MCP event listener",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      // --- Step 6: 初回起動時の tutorial pre-fill ---
      // PTY spawn 後に呼ぶ必要があるため、Terminal mount を少し待つ。
      // ptyWrite は改行なしで送り、Enter はユーザーが押す（PTY observation only に抵触しない）。
      // フラグは pre-fill 成功直後に立てる（AI の判断に依存しない確実な経路）。
      try {
        const { checkTutorialDone } = await import("./bindings/tauri-commands");
        const done = await checkTutorialDone();
        if (!done) {
          setTimeout(async () => {
            try {
              const { ptyWrite, markTutorialDone } = await import("./bindings/tauri-commands");
              await ptyWrite({ data: "/charm:tutorial" });
              await markTutorialDone();
            } catch (err) {
              appLog.write({
                phase: "tutorial-prefill",
                note: "pre-fill failed (PTY may not be ready yet)",
                data: { error: err instanceof Error ? err.message : String(err) },
              });
            }
          }, 2000);
        }
      } catch (err) {
        appLog.write({
          phase: "tutorial-prefill",
          note: "tutorial flag check failed",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    }

    // bootstrap を fire-and-forget で起動。runtime singleton は HMR 越しに 1 度しか
    // 動かないので多重 load にはならない。各 step は独自に try/catch を持つので
    // この catch は現実には走らないが、念のため userLayerReady を解放しておく
    // （Promise が permanently pending になって Terminal が永遠に mount されないのを防ぐ）。
    void bootstrap().catch((err: unknown) => {
      appLog.write({
        phase: "bootstrap",
        note: "bootstrap crashed (unexpected)",
        data: { error: err instanceof Error ? err.message : String(err) },
      });
      userLayerReadyResolve({ terminalAgent: "claude", defaultSpec: null, systemPrompt: null });
    });

    return {
      time,
      bus,
      dispatcher,
      perception,
      logBridge,
      devLog,
      effectDispatcher,
      scenePackRegistry,
      uiPackRegistry,
      claimState,
      uiState,
      userLayerReady,
    };
  });

  const {
    perception,
    dispatcher,
    logBridge,
    devLog,
    effectDispatcher,
    scenePackRegistry,
    uiPackRegistry,
    claimState,
    uiState,
    time,
    userLayerReady,
  } = runtime;

  // user layer load（bundled + user pack 登録、primaryPersona 反映）完了を待ってから
  // Terminal を mount する。これで coding agent の PTY spawn は確定した primaryPersona の
  // prompt overlay で 1 回だけ走る（多重 spawn / null prompt race を回避）。
  const [isUserLayerReady, setIsUserLayerReady] = useState(false);
  const [terminalAgent, setTerminalAgent] = useState<TerminalAgent>("claude");
  const [defaultSpec, setDefaultSpec] = useState<SpawnSpec | null>(null);
  // undefined = まだ未解決、null = 空（非注入）、string = 注入する内容。
  const [resolvedSystemPrompt, setResolvedSystemPrompt] = useState<string | null | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    userLayerReady.then(({ terminalAgent: agent, defaultSpec: spec, systemPrompt }) => {
      if (!cancelled) {
        setTerminalAgent(agent);
        setDefaultSpec(spec);
        setResolvedSystemPrompt(systemPrompt);
        setIsUserLayerReady(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [userLayerReady]);

  // ── Session tab manager（HMR-surviving singleton）───────────────────────
  // biome-ignore lint/correctness/useExhaustiveDependencies: runtime は HMR-surviving singleton、bus は stable reference
  const tabManager = useMemo(
    () =>
      getOrInit(
        KEYS.SESSION_TAB_MANAGER,
        () =>
          new SessionTabManager(DEFAULT_SESSION_ID, {
            onEvent: (name, payload) => {
              runtime.bus.emitSynthetic(
                { type: "utility", packId: "charminal:session-tabs" },
                name,
                payload,
                0,
              );
            },
          }),
      ),
    [],
  );

  const [tabState, setTabState] = useState<SessionTabState>(() => tabManager.getState());
  const [isSessionRestoreReady, setIsSessionRestoreReady] = useState(false);
  const preferredActiveSessionIdRef = useRef<string | null | undefined>(undefined);
  if (preferredActiveSessionIdRef.current === undefined) {
    preferredActiveSessionIdRef.current = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  }

  useEffect(() => {
    return tabManager.subscribe(setTabState);
  }, [tabManager]);

  useEffect(() => {
    if (!isUserLayerReady) return;
    let cancelled = false;

    sessionList()
      .then((descriptors) => {
        if (cancelled) return;
        tabManager.restoreSessions(descriptors, preferredActiveSessionIdRef.current ?? null);
      })
      .catch((err) => {
        console.warn("[session-tabs] failed to restore sessions after reload:", err);
      })
      .finally(() => {
        if (!cancelled) setIsSessionRestoreReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [isUserLayerReady, tabManager]);

  useEffect(() => {
    localStorage.setItem(ACTIVE_SESSION_STORAGE_KEY, tabState.activeSessionId);
  }, [tabState.activeSessionId]);

  const canMountTerminals =
    isUserLayerReady && isSessionRestoreReady && resolvedSystemPrompt !== undefined;

  // scene 変更時に active session の terminal テーマを更新する。
  // initTerminalTheme は runtime factory 内で DEFAULT_SESSION_ID 固定のため、
  // shell tab が active の場合に scene 変更が反映されない問題を補完する。
  useEffect(() => {
    if (!isUserLayerReady) return;
    const sub = scenePackRegistry.subscribeActive((scene) => {
      const activeId = tabManager.getState().activeSessionId;
      const rt = getTerminalRuntime(activeId);
      rt.setTheme(scene?.terminal ?? DEFAULT_TERMINAL_THEME);
      rt.refit();
    });
    return () => sub.dispose();
  }, [isUserLayerReady, scenePackRegistry, tabManager]);

  // active scene entry を Registry から subscribe して React state に流す。
  // SceneSpec が必要な UI context 系は entry.scene から既存どおり組み立てる。
  const [activeSceneEntry, setActiveSceneEntryState] = useState<ScenePackEntry | null>(() =>
    scenePackRegistry.getActiveEntry(),
  );
  useEffect(() => {
    const sub = scenePackRegistry.subscribeActiveEntry((entry) => setActiveSceneEntryState(entry));
    return () => sub.dispose();
  }, [scenePackRegistry]);
  const activeScene = activeSceneEntry?.scene ?? null;
  const [sceneLayerOverrides, setSceneLayerOverrides] = useState<ReadonlyArray<SceneLayerOverride>>(
    [],
  );
  const renderedScene = useMemo(
    () => applySceneLayerOverrides(activeScene, sceneLayerOverrides),
    [activeScene, sceneLayerOverrides],
  );
  const renderedSceneEntry = useMemo<ScenePackEntry | null>(() => {
    if (activeSceneEntry === null || renderedScene === null) return null;
    if (renderedScene === activeSceneEntry.scene) return activeSceneEntry;
    return { ...activeSceneEntry, scene: renderedScene };
  }, [activeSceneEntry, renderedScene]);
  const renderedSceneRef = useRef<SceneSpec | null>(renderedScene);
  const sceneListenersRef = useRef(new Set<(scene: SceneSpec | null) => void>());
  // initAmbientAudio で生成した engine を buildUiContext からも触れるよう保持する。
  const ambientAudioEngineRef = useRef<AmbientAudioRuntime | null>(null);

  useEffect(() => {
    renderedSceneRef.current = renderedScene;
    for (const listener of Array.from(sceneListenersRef.current)) {
      listener(renderedScene);
    }
  }, [renderedScene]);

  useEffect(() => {
    registerSceneLayerBridge({
      updateLayer: (target, patch) => {
        setSceneLayerOverrides((prev) => upsertSceneLayerOverride(prev, target, patch));
      },
      resetLayer: (target) => {
        setSceneLayerOverrides((prev) => removeSceneLayerOverride(prev, target));
      },
      getScene: () => renderedSceneRef.current,
    });
  }, []);

  // ── active persona を PersonaRegistryImpl から subscribe ────────────────
  // bundled clai は runtime factory 内で register 済み。
  // config.primaryPersona が切り替わった場合、次の Terminal セッションから反映される。
  // 既存 PTY session への注入は PTY observation-only 原則で行わない
  // （philosophy: docs/philosophy/INHABITED_CHARACTER_INTERFACE.md 「観察の境界」）。
  const personaRegistry = getPersonaRegistry();
  const [, setPrimaryPersonaState] = useState<PersonaDefinition | null>(() =>
    personaRegistry.getActivePersona(),
  );
  useEffect(() => {
    const sub = personaRegistry.subscribeActive(setPrimaryPersonaState);
    return () => sub.dispose();
  }, [personaRegistry]);

  /**
   * VRM file path を local state と localStorage に同時反映する。
   * UI pack（`ctx.app.setVrm`）と sidebar の picker 経路で共有する。
   */
  const applyVrmPath = useCallback((path: string | null) => {
    setVrmPath(path);
    if (path === null) {
      localStorage.removeItem(VRM_STORAGE_KEY);
    } else {
      localStorage.setItem(VRM_STORAGE_KEY, path);
    }
  }, []);

  // ── UI pack: subscribe + mount / dispose lifecycle ────────────────────
  // active UI pack が切り替わるたびに前の pack を teardown（dispose + container remove +
  // layout reset）してから新しい pack の layout を apply、container を body 直下に挿入、
  // mount を呼ぶ。Terminal / Sidebar / charactor-container が DOM に生えるまでは
  // subscribe 自体を遅延させる（querySelector が null を返す事故の回避）。
  //
  // container は React tree 外（document.body 直下）：pack が描画する overlay を
  // Charminal 本体の layout と独立にするため。pointer-events: none で default 透過し、
  // pack 側で auto を明示した要素だけがクリックを受ける。
  useEffect(() => {
    // Terminal が mount されるまでは subscribe しない（空振り事故防止）。
    // bundled register は factory 内の同期 code なので、ここに到達した時点で registry は既に埋まっている。
    if (!isUserLayerReady) return;

    let currentDisposable: Disposable | null = null;
    let currentContainer: HTMLDivElement | null = null;
    let currentAbort: AbortController | null = null;

    const makeLayoutTargets = (terminal: HTMLElement): LayoutTargets | null => {
      const sidebar = document.querySelector<HTMLElement>(".sidebar");
      const character = document.querySelector<HTMLElement>(".charactor-container");
      if (!sidebar || !character) return null;
      return {
        root: document.documentElement,
        terminal,
        sidebar,
        character,
      };
    };

    const getTerminalElements = (): HTMLElement[] => [
      ...document.querySelectorAll<HTMLElement>(".terminal-container"),
    ];

    const getLayoutTargets = (): LayoutTargets | null => {
      const activeSessionId = tabManager.getState().activeSessionId;
      const activeTerminal =
        getTerminalElements().find((el) => el.dataset.sessionId === activeSessionId) ??
        getTerminalElements().find((el) => el.dataset.active === "true") ??
        null;
      return activeTerminal ? makeLayoutTargets(activeTerminal) : null;
    };

    const getAllLayoutTargets = (): LayoutTargets[] =>
      getTerminalElements().flatMap((terminal) => {
        const targets = makeLayoutTargets(terminal);
        return targets ? [targets] : [];
      });

    const refitActiveTerminal = () => {
      getTerminalRuntime(tabManager.getState().activeSessionId).refit();
    };

    const resetLayoutForAllTerminals = (): boolean => {
      const targetsList = getAllLayoutTargets();
      for (const targets of targetsList) resetLayout(targets);
      return targetsList.length > 0;
    };

    const applyLayoutForAllTerminals = (layout: UiLayout): LayoutTargets | null => {
      const targetsList = getAllLayoutTargets();
      for (const targets of targetsList) applyLayout(layout, targets);
      return getLayoutTargets() ?? targetsList[0] ?? null;
    };

    // 設定 write は read-modify-write なので並行 click で race する。
    // Promise chain で逐次化する（同 useEffect 寿命内で 1 本）。
    let pendingConfigWrite: Promise<void> = Promise.resolve();
    const updateConfig = (
      patch: Partial<{
        primaryPersona: string | null;
        activeScene: string | null;
        terminalAgent: "claude" | "codex";
        ambientAudioMuted: boolean;
        ambientAudioVolume: number;
      }>,
    ): Promise<void> => {
      const next = pendingConfigWrite.then(async () => {
        const cur = parseConfig(await readCharminalConfigText());
        await writeCharminalConfigText(serializeConfig({ ...cur, ...patch }));
      });
      pendingConfigWrite = next.catch(() => undefined);
      return next;
    };

    /**
     * activeAmbientUi を read-modify-write で更新する config helper。
     * withActiveAmbientUiSet を使って config を immutable に更新し、
     * registry 側の enable/disable も同期する。
     */
    const updateActiveAmbientUi = (ids: readonly string[]): Promise<void> => {
      const next = pendingConfigWrite.then(async () => {
        const cur = parseConfig(await readCharminalConfigText());
        const updated = withActiveAmbientUiSet(cur, ids);
        await writeCharminalConfigText(serializeConfig(updated));

        // registry 側の active set を同期する
        const ambientUiRegistry = getAmbientUiPackRegistry();
        const currentActive = new Set(ambientUiRegistry.getActiveSet());
        const nextActive = new Set(ids);
        for (const id of currentActive) {
          if (!nextActive.has(id)) ambientUiRegistry.disable(id);
        }
        for (const id of nextActive) {
          if (!currentActive.has(id)) ambientUiRegistry.enable(id);
        }
      });
      pendingConfigWrite = next.catch(() => undefined);
      return next;
    };

    const buildUiContext = (packId: string, signal: AbortSignal): UiContext => {
      const threeRuntime = getThreeRuntime();

      // ── tween: pack-scoped TweenAPI ─────────────────────────
      const tweenManager = threeRuntime.getTweenManager();
      const tweenPrefix = `pack:${packId}:`;
      const tween: TweenAPI = {
        start(key, to, durationMs, apply, options) {
          return tweenManager.start(tweenPrefix + key, to, durationMs, apply, options);
        },
        startVec3(key, to, durationMs, apply, options) {
          return tweenManager.startVec3(tweenPrefix + key, to, durationMs, apply, options);
        },
        cancel(key) {
          tweenManager.cancel(tweenPrefix + key);
        },
      };
      signal.addEventListener(
        "abort",
        () => {
          tweenManager.cancelByPrefix(tweenPrefix);
        },
        { once: true },
      );

      const three: UiThreeAPI = {
        get camera() {
          return threeRuntime.getCamera();
        },
        get scene() {
          return threeRuntime.getScene();
        },
        get renderer() {
          return threeRuntime.getRenderer();
        },
        get vrm() {
          return threeRuntime.getVrm();
        },
        setCameraTracking: (enabled) => threeRuntime.setCameraTracking(enabled),
        getCameraTracking: () => threeRuntime.getCameraTracking(),
      };
      const claim: UiClaimAPI = {
        camera: () => claimState.claim("camera"),
        expression: () => claimState.claim("expression"),
        animation: () => claimState.claim("animation"),
        isClaimed: (kind) => claimState.isClaimed(kind),
      };
      const state: UiContext["state"] = {
        get: (key) => uiState.get(packId, key),
        set: (key, value) => uiState.set(packId, key, value),
        subscribe: (key, listener) => uiState.subscribe(packId, key, listener),
      };
      const scene: UiContext["scene"] = {
        get: () => renderedSceneRef.current,
        subscribe: (listener) => {
          sceneListenersRef.current.add(listener);
          listener(renderedSceneRef.current);
          return {
            dispose: () => {
              sceneListenersRef.current.delete(listener);
            },
          };
        },
        updateLayer: (target, patch) => {
          if (sceneLayerTargetKey(target) === null) {
            devLog.write({
              subsystem: "UiPack",
              phase: "scene",
              note: `ignored invalid scene layer target from "${packId}"`,
            });
            return;
          }
          setSceneLayerOverrides((prev) => upsertSceneLayerOverride(prev, target, patch));
        },
        resetLayer: (target) => {
          setSceneLayerOverrides((prev) => removeSceneLayerOverride(prev, target));
        },
        resetAll: () => {
          setSceneLayerOverrides([]);
        },
      };

      return {
        space: {
          injectEffect: (request) => effectDispatcher.dispatch(request),
        },
        // character は最小 stub（character の実接続は別 plan）。
        // SDK 型の全 field を満たす（GazeHandle は target / active / release 3 field 必須）。
        character: {
          express: () => ({
            target: { kind: "mood", preset: "relaxed" },
            requestedIntensity: 0,
            effectiveWeight: 0,
            setIntensity: () => {},
            release: () => {},
          }),
          play: () => ({
            animation: "anim:noop",
            startedAt: 0,
            setWeight: () => {},
            stop: () => Promise.resolve(),
            cancel: () => {},
            completion: Promise.resolve(),
          }),
          gaze: () => ({
            target: { kind: "away" },
            active: false,
            release: () => {},
          }),
          interrupt: () => {},
        },
        three,
        claim,
        scene,
        state,
        time,
        tween,
        log: createLogAPI(logBridge, packId),
        signal,
        layout: {
          update: (layout: UiLayout) => {
            resetLayoutForAllTerminals();
            applyLayoutForAllTerminals(layout);
            refitActiveTerminal();
          },
        },
        app: {
          setVrm: (path: string | null) => applyVrmPath(path),
          listPersonas: () =>
            personaRegistry.listEntries().map((e) => ({
              id: e.id,
              name: e.persona.name,
              origin: e.origin,
            })),
          listScenes: () =>
            scenePackRegistry.listEntries().map((e) => ({
              id: e.id,
              name: e.manifest.name,
              origin: e.origin,
            })),
          setPrimaryPersona: async (id) => {
            await updateConfig({ primaryPersona: id });
            personaRegistry.setPrimaryPersona(id);
          },
          setActiveScene: async (id) => {
            await updateConfig({ activeScene: id });
            scenePackRegistry.setActiveScene(id);
          },
          setTerminalAgent: async (agent) => {
            await updateConfig({ terminalAgent: agent });
            // terminalAgent は既存セッションに反映しない仕様（仕様書通り）
          },
          setAmbientAudioMuted: async (muted) => {
            await updateConfig({ ambientAudioMuted: muted });
            ambientAudioEngineRef.current?.setMuted(muted);
          },
          setActiveAmbientUi: async (ids) => {
            await updateActiveAmbientUi(ids);
          },
          setAmbientAudioVolume: async (volume) => {
            await updateConfig({ ambientAudioVolume: volume });
            ambientAudioEngineRef.current?.setMasterVolume(volume);
          },
          getConfig: async () => {
            const text = await readCharminalConfigText();
            const cur = parseConfig(text);
            return {
              primaryPersona: cur.primaryPersona,
              activeScene: cur.activeScene,
              terminalAgent: cur.terminalAgent,
              ambientAudioMuted: cur.ambientAudioMuted,
              ambientAudioVolume: cur.ambientAudioVolume,
              activeAmbientUi: cur.activeAmbientUi,
            };
          },
        },
        emitEvent: (name: string, payload?: unknown) => {
          runtime.bus.emitSynthetic({ type: "utility", packId }, name, payload, 0);
        },
      };
    };

    const activateEntry = (entry: UiPackEntry | null) => {
      // 前の UI pack を cleanup
      if (currentAbort) currentAbort.abort();
      currentAbort = null;
      if (currentDisposable) currentDisposable.dispose();
      currentDisposable = null;
      if (currentContainer) {
        currentContainer.remove();
        currentContainer = null;
      }
      if (resetLayoutForAllTerminals()) refitActiveTerminal();
      claimState.releaseAll();
      setSceneLayerOverrides([]);

      if (!entry) return;

      const targets = applyLayoutForAllTerminals(entry.pack.layout);
      if (!targets) {
        devLog.write({
          subsystem: "UiPack",
          phase: "mount",
          note: `deferred mount of "${entry.id}" (DOM targets missing)`,
        });
        return;
      }
      refitActiveTerminal();
      const container = document.createElement("div");
      container.className = "ui-pack-container";
      container.style.position = "fixed";
      container.style.inset = "0";
      container.style.pointerEvents = "none";
      container.style.zIndex = "50";
      document.body.appendChild(container);

      const abort = new AbortController();
      currentAbort = abort;
      currentContainer = container;

      const ctx = buildUiContext(entry.id, abort.signal);
      try {
        currentDisposable = entry.pack.mount(ctx, container);
      } catch (err) {
        devLog.write({
          subsystem: "UiPack",
          phase: "mount",
          note: `mount failed for "${entry.id}"`,
          data: { error: err instanceof Error ? err.message : String(err) },
        });
        container.remove();
        currentContainer = null;
        abort.abort();
        currentAbort = null;
        claimState.releaseAll();
      }
    };

    const sub = uiPackRegistry.subscribeActive(activateEntry);

    return () => {
      sub.dispose();
      if (currentAbort) currentAbort.abort();
      if (currentDisposable) currentDisposable.dispose();
      if (currentContainer) currentContainer.remove();
      if (resetLayoutForAllTerminals()) refitActiveTerminal();
      claimState.releaseAll();
      setSceneLayerOverrides([]);
    };
  }, [
    uiPackRegistry,
    effectDispatcher,
    time,
    devLog,
    claimState,
    uiState,
    isUserLayerReady,
    logBridge,
    applyVrmPath,
    runtime,
    personaRegistry,
    scenePackRegistry,
    tabManager,
  ]);

  const bodyDevLog = useMemo(() => createSubsystemLog(devLog, "Body"), [devLog]);

  // ── Body ↔ PersonaReflexDispatcher wiring ──────────────────

  const bodyRef = useRef<Body | null>(null);
  const greetedRef = useRef(false);
  const inTurnRef = useRef(false);

  const handleBodyReady = useCallback(
    (body: Body | null) => {
      bodyRef.current = body;
      if (body) {
        body.initAttention();
        dispatcher.setContextFactory(
          createRealPersonaContextFactory({ body, logBridge, effectDispatcher }),
        );
        if (!greetedRef.current) {
          greetedRef.current = true;
          // Delay the greeting nod so it feels like a considered "hello"
          // instead of a reflex the moment the VRM appears on screen.
          setTimeout(() => {
            bodyRef.current?.createCharacterAPI().play("anim:VRMA_small_nod", {
              fadeInMs: 1200,
              fadeOutMs: 800,
              weight: 0.8,
              speed: 0.7,
            });
          }, 3000);
        }
      } else {
        dispatcher.setContextFactory(createStubPersonaContextFactory());
      }
    },
    [dispatcher, logBridge, effectDispatcher],
  );

  // ── Tool-activity → Body state wiring ─────────────────────

  useEffect(() => {
    // Claude のターン中、tool-activity "none" は idle ではなく thinking に戻す。
    // ターン境界: user-prompt-submit で true、stop で false。
    const mapActivity = (activity: string): EyeState => {
      switch (activity) {
        case "reading":
          return "reading";
        case "writing":
          return "writing";
        case "running":
          return "running";
        case "none":
          return inTurnRef.current ? "thinking" : "idle";
        default:
          return inTurnRef.current ? "thinking" : "idle";
      }
    };

    const moduleRegistry = getModuleRegistry();
    const trigger: Trigger = {
      id: "builtin:tool-activity-to-body-state",
      match: (event) => {
        if (event.kind === "tool-activity") {
          bodyRef.current?.setState(mapActivity(event.activity));
        }
        if (event.kind === "hook-signal" && event.signal.name === "user-prompt-submit") {
          inTurnRef.current = true;
          bodyRef.current?.setState("thinking");
        }
        if (event.kind === "hook-signal" && event.signal.name === "pre-tool-use") {
          bodyRef.current?.setState("thinking");
        }
        if (event.kind === "hook-signal" && event.signal.name === "stop") {
          inTurnRef.current = false;
          bodyRef.current?.setState("idle");
        }
        return null; // never emit a reaction — side-effect only
      },
    };

    const handle = moduleRegistry.register("trigger-handler", {
      id: trigger.id,
      provenance: { source: "builtin" },
      instance: trigger,
    });

    // EventBus dispatch を ModuleRegistry.list("trigger-handler") に切り替える本格
    // refactor は別 plan。現状は EventBus 登録も並行で残し、provenance: "builtin"
    // が明示されたことを Phase 1 の主たる成果とする。
    const reg = runtime.bus.register(trigger, () => {}, {
      type: "persona",
      packId: "__body-state__",
    });

    return () => {
      reg?.dispose();
      handle.dispose();
    };
  }, [runtime]);

  // ── Hook-signal listener (global, independent of PTY lifecycle) ──

  useEffect(() => {
    let polling = true;
    const appLog = createSubsystemLog(devLog, "App");
    appLog.write({ phase: "polling", note: "starting hook-signal polling" });

    const poll = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      appLog.write({ phase: "polling", note: "loop started" });
      while (polling) {
        try {
          const signals = await invoke<string[]>("poll_hook_signals");
          if (signals.length > 0) {
            appLog.write({ phase: "polling", note: "polled signals", data: signals });
          }
          for (const sig of signals) {
            perception.onHookSignal(sig);
          }
        } catch (err) {
          console.warn("[App] poll_hook_signals failed:", err);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    poll().catch((err) => {
      console.error("[App] polling setup failed:", err);
    });

    return () => {
      polling = false;
    };
  }, [perception, devLog]);

  // NOTE: perception.dispose() is NOT called in useEffect cleanup.
  // StrictMode runs cleanup even for [] deps, which would dispose the
  // shared Perception instance. The idle timer is harmless to leave running.

  // ── Folder picker ─────────────────────────────────────────────

  const handlePickFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        title: "プロジェクトフォルダを選択",
      });
      if (selected) {
        const nextCwd = selected as string;
        if (nextCwd === cwd) return;
        localStorage.setItem(CWD_STORAGE_KEY, nextCwd);
        // Workspace 切替は runtime singleton 群を一度作り直す。
        // PTY / xterm / perception の寿命が絡むため、差分更新より WebView reload の方が安定する。
        window.location.reload();
      }
    } catch {
      // Dialog not available outside Tauri
    }
  }, [cwd]);

  // ── Settings ─────────────────────────────────────────────

  const handleOpenSettings = useCallback(() => {
    const uiPackRegistry = getUiRegistry();
    const uiState = getUiStateStore();
    const current = uiPackRegistry.getActiveUi()?.id ?? null;

    if (current === SETTINGS_PACK_ID) {
      // 既に開いている → 閉じる（toggle）。✕ ボタンと同じ復元 logic を共有する。
      const saved = uiState.get(SETTINGS_PACK_ID, PREVIOUS_ACTIVE_UI_KEY);
      const savedStr = typeof saved === "string" ? saved : null;
      const availableIds = uiPackRegistry.listEntries().map((e) => e.id);
      const target = resolveCloseTarget({ saved: savedStr, availableIds });
      uiPackRegistry.setActiveUi(target);
      return;
    }

    // 閉じている → 開く。現 activeUi を previous として保存。
    uiState.set(SETTINGS_PACK_ID, PREVIOUS_ACTIVE_UI_KEY, current);
    uiPackRegistry.setActiveUi(SETTINGS_PACK_ID);
  }, []);

  const [vrmUrl, setVrmUrl] = useState<string | null>(null);

  // Convert filesystem path to Tauri asset URL
  useEffect(() => {
    if (!vrmPath) {
      setVrmUrl(null);
      return;
    }
    import("@tauri-apps/api/core")
      .then(({ convertFileSrc }) => {
        setVrmUrl(convertFileSrc(vrmPath));
      })
      .catch(() => setVrmUrl(null));
  }, [vrmPath]);

  // ambient-ui packs を document.body 直下の #ambient-layer に mount/unmount する。
  // subscribeActiveSet で active set の変化を購読し、差分調整（reconcile）する。
  //
  // ── なぜ document.body 直下か ──
  // xterm の xtermContainer も document.body 直下（zIndex: 1）に命令的に append される。
  // React の #root は xterm より先に DOM に存在するため、#root 内の fixed 要素は
  // DOM 順で先行するノードの stacking context に収まり、後から append された
  // xtermContainer の下に隠れる。
  // ambientLayer を xtermContainer より後に body に append することで、
  // z-index 競合なしに xterm の上に重ねられる（v1 と同じ戦略）。
  // biome-ignore lint/correctness/useExhaustiveDependencies: singletons + DOM are stable
  useEffect(() => {
    const ambientUiRegistry = getAmbientUiPackRegistry();
    const attention = getAttentionRuntime();

    // #ambient-layer を document.body 直下に生成する（v1 の zIndex: 20 を踏襲）
    const ambientLayer = document.createElement("div");
    ambientLayer.id = "ambient-layer";
    ambientLayer.setAttribute("aria-hidden", "true");
    ambientLayer.style.position = "fixed";
    ambientLayer.style.inset = "0";
    ambientLayer.style.pointerEvents = "none";
    ambientLayer.style.zIndex = "20";
    document.body.appendChild(ambientLayer);

    type Mounted = { container: HTMLDivElement; disposable: Disposable };
    const mounted = new Map<string, Mounted>();

    const reconcile = (activeIds: ReadonlyArray<string>): void => {
      const activeSet = new Set(activeIds);

      for (const [id, entry] of mounted) {
        if (!activeSet.has(id)) {
          entry.disposable.dispose();
          entry.container.remove();
          mounted.delete(id);
        }
      }

      for (const id of activeIds) {
        if (mounted.has(id)) continue;
        const packEntry = ambientUiRegistry.listEntries().find((e) => e.id === id);
        if (packEntry === undefined) continue;

        const container = document.createElement("div");
        container.className = "ambient-ui-container";
        container.dataset.packId = id;
        ambientLayer.appendChild(container);

        const ctx: AmbientUiContext = { attention };
        const disposable = packEntry.pack.mount(ctx, container);
        mounted.set(id, { container, disposable });
      }
    };

    const sub = ambientUiRegistry.subscribeActiveSet(reconcile);
    reconcile(ambientUiRegistry.getActiveSet());

    return () => {
      sub.dispose();
      for (const [, entry] of mounted) {
        entry.disposable.dispose();
        entry.container.remove();
      }
      mounted.clear();
      ambientLayer.remove();
    };
  }, []);

  // terminal 非依存の attention producer（mouse / dev / focused-dom）。初回のみ起動。
  // biome-ignore lint/correctness/useExhaustiveDependencies: singletons are stable
  useEffect(() => {
    const attention = getAttentionRuntime();
    const disposables: Disposable[] = [];
    disposables.push(startMouseAttentionProducer({ attention }));
    disposables.push(startDevAttentionProducer({ attention, isDev: import.meta.env.DEV }));
    disposables.push(startFocusedDomAttentionProducer({ attention }));
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, []);

  // terminal 依存の attention producer。active tab が変わるたびに再構築する。
  useEffect(() => {
    const attention = getAttentionRuntime();
    const terminal = getTerminalRuntime(tabState.activeSessionId);

    const disposables: Disposable[] = [];
    disposables.push(startTerminalAttentionProducer({ attention, terminal }));

    const subscribeHookSignal = (handler: (event: { name: string }) => void): Disposable => {
      const trigger = {
        id: "builtin:hook-signal-to-tool-attention",
        match: (event: import("@charminal/sdk").DispatchEvent) => {
          if (event.kind === "hook-signal") {
            return { reaction: "__noop__" as import("@charminal/sdk").ReactionType };
          }
          return null;
        },
      };
      const reg = runtime.bus.register(
        trigger,
        (reactionEvent) => {
          const dispatched = reactionEvent.triggeredBy;
          if (dispatched.kind === "hook-signal") {
            handler({ name: dispatched.signal.name });
          }
        },
        { type: "persona", packId: "__tool-attention__" },
      );
      return { dispose: () => reg.dispose() };
    };

    const subscribeToolActivity = (
      handler: (event: { activity: string; timestamp: number }) => void,
    ): Disposable => {
      const trigger = {
        id: "builtin:tool-activity-to-attention",
        match: (event: import("@charminal/sdk").DispatchEvent) => {
          if (event.kind === "tool-activity") {
            return { reaction: "__noop__" as import("@charminal/sdk").ReactionType };
          }
          return null;
        },
      };
      const reg = runtime.bus.register(
        trigger,
        (reactionEvent) => {
          const dispatched = reactionEvent.triggeredBy;
          if (dispatched.kind === "tool-activity") {
            handler({ activity: dispatched.activity, timestamp: dispatched.timestamp });
          }
        },
        { type: "persona", packId: "__tool-attention__" },
      );
      return { dispose: () => reg.dispose() };
    };

    const getCurrentLineRect = () => terminal.getViewportLineRects()[0]?.rect ?? null;

    disposables.push(startInputCursorAttentionProducer({ attention, terminal }));

    disposables.push(
      startToolAttentionProducer({
        attention,
        subscribeHookSignal,
        subscribeToolActivity,
        getCurrentLineRect,
      }),
    );

    return () => {
      for (const d of disposables) d.dispose();
    };
    // biome-ignore lint/correctness/useExhaustiveDependencies: runtime.bus.register は stable reference
  }, [tabState.activeSessionId, runtime.bus.register]);

  // mcp attention producer を起動する。
  // @tauri-apps/api/event の listen を ListenFactory に adapt して inject する。
  // dynamic import は非同期のため、他 producer の起動を妨げないよう独立した useEffect に分離。
  // biome-ignore lint/correctness/useExhaustiveDependencies: singletons are stable
  useEffect(() => {
    const attention = getAttentionRuntime();
    let disposed = false;
    let producerDisposable: Disposable | null = null;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");

      const listenFactory = <P,>(eventName: string, handler: (payload: P) => void): Disposable => {
        let unlisten: (() => void) | null = null;
        let cancelled = false;
        void listen<P>(eventName, (event) => handler(event.payload)).then((fn) => {
          if (cancelled) {
            fn();
          } else {
            unlisten = fn;
          }
        });
        return {
          dispose: () => {
            cancelled = true;
            if (unlisten !== null) {
              unlisten();
              unlisten = null;
            }
          },
        };
      };

      // v1 `setMcpRequestAttention` と同じ rect 選択ロジック。
      // get-ui-state / set-ui-state → activeUi（非 ambient UI コンテナ）、
      // それ以外 → sidebar。両方なければ null を返す。
      const getTargetRect = (tool: string) => {
        const activeUi = document.querySelector<HTMLElement>(
          ".ui-pack-container:not(.ui-pack-container--ambient)",
        );
        const sidebar = document.querySelector<HTMLElement>(".sidebar");
        const targetElement =
          tool === "get-ui-state" || tool === "set-ui-state" ? (activeUi ?? sidebar) : sidebar;
        const r = targetElement?.getBoundingClientRect();
        if (r === undefined || r.width <= 0 || r.height <= 0) return null;
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      };

      if (disposed) return;
      producerDisposable = startMcpAttentionProducer({
        attention,
        listen: listenFactory,
        getTargetRect,
      });
    })();

    return () => {
      disposed = true;
      if (producerDisposable !== null) {
        producerDisposable.dispose();
        producerDisposable = null;
      }
    };
  }, []);

  const folderName = useMemo(() => (cwd ? cwd.split("/").pop() || cwd : "デフォルト"), [cwd]);

  // ── Settings: close-requested listener ─────────────────────

  useEffect(() => {
    const onCloseRequested = (event: Event) => {
      const detail = (event as CustomEvent<{ target: string | null }>).detail;
      const uiPackRegistry = getUiRegistry();
      const availableIds = uiPackRegistry.listEntries().map((e) => e.id);
      const target = resolveCloseTarget({ saved: detail?.target ?? null, availableIds });
      uiPackRegistry.setActiveUi(target);
    };
    window.addEventListener("charminal-settings:close-requested", onCloseRequested);
    return () => {
      window.removeEventListener("charminal-settings:close-requested", onCloseRequested);
    };
  }, []);

  // ── Session tab keybindings ────────────────────────────────
  useEffect(() => {
    if (!isUserLayerReady) return;
    return installTabKeybindings(tabManager);
  }, [isUserLayerReady, tabManager]);

  // ── PTY exit → auto-respawn / tab close ────────────────────
  const ptyExitCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isUserLayerReady) return;
    let disposed = false;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ session_id: string; code: number }>("pty-exit", (event) => {
        if (disposed) return;
        tabManager.handleSessionExit(event.payload.session_id, event.payload.code);
      });
      if (disposed) {
        unlisten();
      } else {
        ptyExitCleanupRef.current = unlisten;
      }
    })();

    return () => {
      disposed = true;
      ptyExitCleanupRef.current?.();
    };
  }, [isUserLayerReady, tabManager]);

  // ── Cmd+R / Ctrl+R で全体 reload ─────────────────────────

  const [levaHidden, setLevaHidden] = useState(true);

  useEffect(() => {
    if (!levaHidden) {
      const raw = getComputedStyle(document.documentElement)
        .getPropertyValue("--leva-panel-width")
        .trim();
      if ((Number.parseFloat(raw) || 0) <= 0) {
        document.documentElement.style.setProperty("--leva-panel-width", "280px");
      }
    }
  }, [levaHidden]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === "KeyR" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        window.location.reload();
      }
      if (event.code === "F2") {
        event.preventDefault();
        setLevaHidden((prev) => !prev);
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, []);

  // screen-shake は bundled-packs/effects/screen-shake を EffectPackRunner
  // 経由で動かす（runtime singleton で register 済み）。この useEffect は不要。

  return (
    <div className="app">
      <Leva hidden={levaHidden} collapsed={false} flat />
      <Sidebar
        folderName={folderName}
        onPickFolder={handlePickFolder}
        vrmUrl={vrmUrl}
        onOpenSettings={handleOpenSettings}
        onBodyReady={handleBodyReady}
        bodyDevLog={bodyDevLog}
        scene={renderedSceneEntry}
      />
      {canMountTerminals && (
        <>
          {tabState.sessions.map((sessionId) => {
            const sessionCwd = tabManager.getSessionCwd(sessionId);
            return (
              <Terminal
                key={sessionId}
                sessionId={sessionId}
                visible={sessionId === tabState.activeSessionId}
                spec={
                  sessionId === DEFAULT_SESSION_ID
                    ? (defaultSpec ?? {
                        kind: "agent",
                        agent: terminalAgent,
                        systemPrompt: resolvedSystemPrompt,
                      })
                    : { kind: "shell", integration: true }
                }
                cwd={sessionCwd === undefined ? cwd : sessionCwd}
                perception={sessionId === tabState.activeSessionId ? perception : null}
                attachFirst={tabManager.shouldAttachExistingSession(sessionId)}
              />
            );
          })}
          <TabIndicator
            state={tabState}
            labels={
              new Map([
                [DEFAULT_SESSION_ID, terminalAgent],
                ...tabState.sessions
                  .filter((id) => id !== DEFAULT_SESSION_ID)
                  .map((id) => [id, id] as const),
              ])
            }
          />
        </>
      )}
    </div>
  );
}

export default App;
