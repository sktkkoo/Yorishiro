import * as ReactThreeDrei from "@react-three/drei";
import * as ReactThreeFiber from "@react-three/fiber";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type {
  AmbientAudioAPI,
  AmbientAudioState,
  AmbientUiContext,
  Disposable,
  Trigger,
  TweenAPI,
  UiClaimAPI,
  UiContext,
  UiHealthReport,
  UiLayout,
  UiPackManifest,
  UiSceneLayerPatch,
  UiSceneLayerTarget,
  UiThreeAPI,
} from "@yorishiro/sdk";
import { LevaPanel } from "leva";
import * as React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactDomClient from "react-dom/client";
import * as THREE from "three";
import {
  checkTutorialDone,
  markTutorialDone,
  prepareLocalizedPluginDir,
  ptyWrite,
  type SpawnSpec,
  sessionList,
  sessionRefreshTheme,
  snapshotCreate,
  snapshotList,
  snapshotRestore,
} from "./bindings/tauri-commands";
import {
  abandonedFactoryManifest,
  abandonedFactoryPack,
  abandonedMonitorManifest,
  abandonedMonitorPack,
  attentionAuraManifest,
  cameraMoveManifest,
  cameraMovePack,
  claiEnManifest,
  claiEnPack,
  claiJaManifest,
  claiJaPack,
  desaturateManifest,
  desaturatePack,
  fireworksManifest,
  fireworksPack,
  fireworksVolleyManifest,
  fireworksVolleyPack,
  immersiveManifest,
  immersivePack,
  mistyGrasslandsManifest,
  mistyGrasslandsPack,
  musicShelfManifest,
  PREVIOUS_ACTIVE_UI_KEY,
  pomodoroManifest,
  pomodoroUiManifest,
  resolveCloseTarget,
  SETTINGS_PACK_ID,
  screenFlashPack,
  screenShakeManifest,
  screenShakePack,
  simpleRoomManifest,
  simpleRoomPack,
  textPhysicsManifest,
  textPhysicsPack,
  theaterManifest,
  theaterPack,
  yorishiroSettingsManifest,
  yorishiroSettingsPack,
} from "./bundled-packs";
import CharacterSurface from "./character-surface";
import { RestoreConfirmDialog } from "./components/RestoreConfirmDialog";
import {
  formatMainSessionTabLabel,
  formatShellSessionTabLabel,
} from "./components/session-tab-labels";
import {
  deriveSessionTabMetadataBadge,
  deriveSessionTabStatusAttention,
} from "./components/session-tab-metadata-badges";
import TabIndicator, { type TabIndicatorBadge } from "./components/TabIndicator";
import TerminalWorkspace from "./components/TerminalWorkspace";
import type { Body, EyeState } from "./core/body";
import { shouldTriggerStartleForToolFailure } from "./core/body/tool-failure-reflex";
import { createSubsystemLog, DevLog, type DevLogEntry } from "./core/dev-log";
import { collectGlobalPrompt } from "./core/global-prompt";
import { registerEnvironmentFragment } from "./core/global-prompt/environment-fragment";
import { registerJournalFragment } from "./core/global-prompt/journal-fragment";
import { registerVoiceFragment } from "./core/global-prompt/voice-fragment";
import { createLogAPI, LogBridge } from "./core/log-bridge";
import { Perception } from "./core/perception";
import type { Layer, LayerRole, SceneSpec } from "./core/scene";
import { registerSceneLayerBridge } from "./core/scene/scene-layer-bridge";
import { EffectDispatcher, EffectPackRunner, Renderer } from "./core/space";
import { Time } from "./core/time";
import { applyLayout, type LayoutTargets, resetLayout } from "./core/ui-layout";
import { SayTtsEngine, VoicePlayer } from "./core/voice";
import {
  changeStrings,
  getStrings,
  resolveFixedTerminalPrompt,
  resolvePackRepairPrompt,
  restoreConfirmStrings,
} from "./i18n/strings";
import { useReloadCurtain } from "./reload-curtain";
import { type AmbientAudioRuntime, initAmbientAudio } from "./runtime/ambient-audio";
import { getAmbientUiPackRegistry } from "./runtime/ambient-ui-pack-registry";
import { getAmenityPackRegistry } from "./runtime/amenity-pack-registry";
import {
  getAttentionLightCueStore,
  startAttentionLightCueBridge,
} from "./runtime/attention-light-cue";
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
import { registerBundledMusicShelf } from "./runtime/bundled-music-shelf";
import { registerBundledPomodoro } from "./runtime/bundled-pomodoro";
import { registerBundledPomodoroUi } from "./runtime/bundled-pomodoro-ui";
import { EventBus, type EventBusLogger } from "./runtime/event-bus";
import { collectHealthReport } from "./runtime/health-check";
import { buildRestoreRows } from "./runtime/history/describe-snapshot";
import { createHistoryApi } from "./runtime/history/history-api";
import { getOrInit } from "./runtime/hot-data";
import {
  type AppLanguage,
  getBrowserLocales,
  type ResolvedLanguage,
  resolveLanguage,
} from "./runtime/language/language";
import { getModuleRegistry, KEYS } from "./runtime/module-registry";
import { PersonaReflexDispatcher } from "./runtime/persona-reflex";
import type { PersonaEntry } from "./runtime/persona-registry";
import {
  createRealPersonaContextFactory,
  createStubPersonaContextFactory,
  getPersonaRegistry,
} from "./runtime/persona-registry";
import {
  type ApplyPresenceOptions,
  type ApplyPresenceResult,
  applyPresenceLevel,
  getPresenceSnapshot,
  getPresenceState,
  type PresenceIntensityDeps,
  type PresenceLevel,
  type PresenceSource,
  shouldRestorePresenceOnPrompt,
} from "./runtime/presence-intensity";
import {
  readPresenceSidebarWidth,
  syncPresenceClosedStyles,
  writePresenceSidebarWidth,
} from "./runtime/presence-intensity/sidebar-visibility";
import {
  type ActiveUiPresence,
  type PresenceResolution,
  resolvePresence,
} from "./runtime/presence-target";
import {
  applyCurrentProjectSceneSelectionWithResolution,
  type ProjectRootResolution,
  type ProjectSceneSelectionResult,
  projectRootValue,
  resolveCurrentProjectRoot,
} from "./runtime/project-context/project-context";
import {
  getSceneRegistry,
  resolveSceneAssets,
  type ScenePackEntry,
  type ScenePackRegistry,
} from "./runtime/scene-pack-registry";
import {
  getSessionStatusStore,
  hookSignalSeq,
  isAttentionResolvingSignal,
  parseHookAttentionSignal,
  parseHookTargetSessionId,
  type SessionStatus,
} from "./runtime/session-status";
import type {
  SessionTabCwdPersistence,
  SessionTabCwdSnapshot,
  SessionTabState,
} from "./runtime/session-tabs";
import { installTabKeybindings, SessionTabManager } from "./runtime/session-tabs";
import {
  DEFAULT_SESSION_ID,
  resolveDefaultAgentProfileId,
  resolveEffectiveAgent,
  resolveInterruptProtectionModeForSpawnSpec,
  resolveProfile,
  type SessionId,
} from "./runtime/sessions";
import {
  spawnSpecFromDefaultProfile,
  withAgentRuntimeFields,
} from "./runtime/sessions/default-spawn-spec";
import { getSurfaceRegistry, type SurfaceName } from "./runtime/surface-registry";
import {
  getAgentToolRunStore,
  getAllTerminalRuntimes,
  getLoopRunStore,
  getTerminalRuntime,
  mergeRunTimeline,
} from "./runtime/terminal-runtime";
import { initTerminalTheme, syncCurrentTerminalTheme } from "./runtime/terminal-theme";
import { getAttentionLightSettingsStore } from "./runtime/three-runtime/attention-light-settings";
import {
  getRuntimeLevaStore,
  useRuntimeLevaStore,
} from "./runtime/three-runtime/runtime-leva-store";
import {
  getActiveSceneLevaStore,
  useActiveSceneLevaStore,
} from "./runtime/three-runtime/scene-pack-leva-store";
import { getThreeRuntime } from "./runtime/three-runtime/three-runtime";
import { getClaimState } from "./runtime/ui-claim-state";
import { getUiRegistry, type UiPackEntry } from "./runtime/ui-pack-registry";
import {
  playStageTransition,
  type StageSurfaces,
} from "./runtime/ui-pack-transition/stage-transition";
import { getUiStateStore } from "./runtime/ui-state-store";
import { loadUserLayer, reloadSingleUserPack, UserPackRegistry } from "./runtime/user-pack-loader";
import { createUserAmenityContextFactory } from "./runtime/user-pack-loader/amenity-activation";
import {
  parseConfig,
  resolvePrimaryPersonaForLanguage,
  resolveSceneForProject,
  serializeConfig,
  type TerminalAgent,
  type VoiceFrequency,
  withActiveAmbientUiSet,
  withLanguageSet,
  withPrimaryPersonaSet,
  type YorishiroConfig,
} from "./runtime/user-pack-loader/config";
import {
  appendInitReloadErrorMarker,
  stripInitReloadErrorMarker,
} from "./runtime/user-pack-loader/init-changed-title";
import {
  readLastStartupReport,
  readYorishiroConfigText,
  writeYorishiroConfigText,
} from "./runtime/user-pack-loader/yorishiro-io";
import {
  getWorkspaceAttentionStore,
  startCommandRunAttentionProducer,
  startSessionAttentionProducer,
  startWorkspaceAttentionPresenceBridge,
} from "./runtime/workspace-attention";
import * as YorishiroControls from "./sdk/controls";
import type { PersonaDefinition } from "./sdk/persona";
import type { PersonaPackManifest } from "./sdk/persona-pack";
import * as YorishiroR3f from "./sdk/r3f";
import type { ScenePackDefinition, ScenePackManifest } from "./sdk/scene-pack";
import Sidebar from "./sidebar";
import TitleBar from "./title-bar";
import { useSettingsActive, useSidebarOpen } from "./title-bar-state";
import {
  layoutNeedsHostPresenceResume,
  shouldResumeHostPresenceForUiActivation,
} from "./ui-pack-activation";
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

const COMMON_CAMERA_CONTROL_PREFIX = "camera.";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readRuntimeControlValue(path: string): unknown {
  const store = getRuntimeLevaStore();
  const input = store?.getData()[path];
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined;
  return "value" in input ? input.value : undefined;
}

function setRuntimeControlValue(path: string, value: unknown): void {
  const store = getRuntimeLevaStore();
  if (!store?.getVisiblePaths().includes(path)) return;
  store.setValueAtPath(path, value, false);
}

function disableCommonCameraTracking(): void {
  getThreeRuntime().setCameraTracking(false);
  setRuntimeControlValue("camera.tracking", false);
}

function applyCommonCameraControlSet(path: string, value: unknown): void {
  if (!path.startsWith(COMMON_CAMERA_CONTROL_PREFIX)) return;

  const key = path.slice(COMMON_CAMERA_CONTROL_PREFIX.length);
  const runtime = getThreeRuntime();
  const camera = runtime.getCamera();

  if (key === "tracking") {
    if (typeof value === "boolean") runtime.setCameraTracking(value);
    return;
  }

  if (key === "lookAtCharacter") {
    if (value === true) {
      camera.lookAt(0, camera.position.y, 0);
    }
    // lookAt OFF 時は yaw/pitch が useFrame 内で制御するので即時操作は不要。
    return;
  }

  if (key === "fov") {
    if (!isFiniteNumber(value)) return;
    camera.fov = value;
    camera.updateProjectionMatrix();
    return;
  }

  // offset.offsetX / offset.offsetY / offset.offsetZ は tracking 中の
  // カメラ位置オフセット。useFrame 内で毎フレーム加算されるので、
  // ここでは leva store 書き込みだけで十分（side-effect 不要）。
  if (
    key === "tracking offset.offsetX" ||
    key === "tracking offset.offsetY" ||
    key === "tracking offset.offsetZ"
  ) {
    return;
  }

  // rotationX / rotationY は useFrame 内で適用されるので side-effect 不要。
  if (key === "rotationX" || key === "rotationY") {
    return;
  }

  if (key !== "x" && key !== "y" && key !== "z") return;
  if (!isFiniteNumber(value)) return;

  disableCommonCameraTracking();

  const next = {
    x: camera.position.x,
    y: camera.position.y,
    z: camera.position.z,
    [key]: value,
  };
  camera.position.set(next.x, next.y, next.z);
  runtime.setCameraBase(next.x, next.y, next.z);

  if (readRuntimeControlValue("camera.lookAtCharacter") !== false) {
    camera.lookAt(0, next.y, 0);
  }
}

const CWD_STORAGE_KEY = "yorishiro:cwd";
const ACTIVE_SESSION_STORAGE_KEY = "yorishiro:active-session";
const SESSION_TAB_CWD_STORAGE_KEY = "yorishiro:session-tab-cwds";
const VRM_STORAGE_KEY = "yorishiro:vrm";
const HOOK_BADGE_VISIBLE_MS = 6000;

interface RestoreDialogRequest {
  readonly seq: number;
  readonly changeText: string;
  readonly timeText: string;
  readonly runRestore: () => Promise<void>;
}

function isNullableString(value: unknown): value is string | null {
  return typeof value === "string" || value === null;
}

function isSessionTabCwdSnapshot(value: unknown): value is SessionTabCwdSnapshot {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.sessionId === "string" &&
    isNullableString(record.launchCwd) &&
    isNullableString(record.displayCwd) &&
    (record.startedAt === null ||
      (typeof record.startedAt === "number" && Number.isFinite(record.startedAt)))
  );
}

function createSessionTabCwdPersistence(storage: Storage): SessionTabCwdPersistence {
  return {
    load: () => {
      try {
        const raw = storage.getItem(SESSION_TAB_CWD_STORAGE_KEY);
        if (!raw) return [];
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(isSessionTabCwdSnapshot);
      } catch {
        return [];
      }
    },
    save: (snapshots) => {
      try {
        storage.setItem(SESSION_TAB_CWD_STORAGE_KEY, JSON.stringify(snapshots));
      } catch {
        // localStorage failure should not affect session operation.
      }
    },
  };
}

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
  mediaOffsetX?: number;
  mediaOffsetY?: number;
  mediaScale?: number;
  mediaRotation?: number;
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
  applyNumericMediaPatch(next, patch);
  return next;
}

/**
 * media transform 系（offset/scale/rotation）の数値フィールドを patch から当てる。
 * null は削除（= default に戻す）、undefined は据え置き。
 */
function applyNumericMediaPatch(next: MutableLayer, patch: UiSceneLayerPatch): void {
  const fields = ["mediaOffsetX", "mediaOffsetY", "mediaScale", "mediaRotation"] as const;
  for (const field of fields) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (value === null) {
      delete next[field];
    } else if (value !== undefined) {
      next[field] = value;
    }
  }
}

/**
 * Override を scene の既存 layer に当てる。target が match しないときは
 * **新規 layer を作らず no-op + warn**。
 *
 * Scene が layer 構造を握る原則（docs/decisions/scene-layer-override-semantics.md）。
 * 過去には auto-create を行っていたが、character role layer が無い scene
 * （例: abandoned-factory のように R3F-component で全描画する scene）に
 * background/foreground 系 override が当たると ghost layer が生成されて
 * SceneRouter が path 1 を選び、結果として VrmViewer slot が消失する事故を
 * 起こしていた。layer 構造は scene が宣言したもの以外は作らない。
 */
function applySceneLayerOverride(scene: SceneSpec, override: SceneLayerOverride): SceneSpec {
  let found = false;
  const layers = scene.layers.map((layer) => {
    if (!sceneLayerMatchesTarget(layer, override.target)) return layer;
    found = true;
    return applySceneLayerPatch(layer, override.patch);
  });
  if (found) return { ...scene, layers };

  console.warn(
    `[scene-layer] override target ${JSON.stringify(override.target)} has no matching layer in scene "${scene.id}" — ignored (scene が layer を握る原則)`,
  );
  return scene;
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
  var __YORISHIRO_REACT__: typeof React | undefined;
  var __YORISHIRO_REACT_DOM_CLIENT__: typeof ReactDomClient | undefined;
  var __YORISHIRO_REACT_JSX_RUNTIME__: typeof ReactJsxRuntime | undefined;
  var __YORISHIRO_REACT_THREE_DREI__: typeof ReactThreeDrei | undefined;
  var __YORISHIRO_REACT_THREE_FIBER__: typeof ReactThreeFiber | undefined;
  var __YORISHIRO_THREE__: typeof THREE | undefined;
  var __YORISHIRO_SDK_CONTROLS__: typeof YorishiroControls | undefined;
  var __YORISHIRO_SDK_R3F__: typeof YorishiroR3f | undefined;
}

globalThis.__YORISHIRO_REACT__ = React;
globalThis.__YORISHIRO_REACT_DOM_CLIENT__ = ReactDomClient;
globalThis.__YORISHIRO_REACT_JSX_RUNTIME__ = ReactJsxRuntime;
globalThis.__YORISHIRO_REACT_THREE_DREI__ = ReactThreeDrei;
globalThis.__YORISHIRO_REACT_THREE_FIBER__ = ReactThreeFiber;
globalThis.__YORISHIRO_THREE__ = THREE;
globalThis.__YORISHIRO_SDK_CONTROLS__ = YorishiroControls;
globalThis.__YORISHIRO_SDK_R3F__ = YorishiroR3f;

function fallbackSelectorForSurface(name: SurfaceName): string {
  switch (name) {
    case "shell":
      return ".shell-column";
    case "character":
      return ".charactor-container";
    case "chrome":
      return ".sidebar";
  }
}

function getConnectedSurface(name: SurfaceName, fallbackSelector: string): HTMLElement | null {
  const registered = getSurfaceRegistry().get(name);
  if (registered?.isConnected === true) return registered;
  return document.querySelector<HTMLElement>(fallbackSelector);
}

// presence 契約の単一解決点（spec §4 loud-unavailable）。
// active UI pack の presence 宣言（無ければ host 既定 = classic shell）から
// surface を解決。stale HMR surface は使わず、現 DOM の connected node に寄せる。
// module-level: getUiRegistry()/getSurfaceRegistry() は HMR singleton なので
// どの closure からでも同一 registry を引ける（App.tsx 既存の getUiRegistry() 再取得と同方針）。
function resolvePresenceSurface(): PresenceResolution {
  const active = getUiRegistry().getActiveUi();
  const a: ActiveUiPresence = active
    ? { kind: "pack", id: active.id, presence: active.pack.layout.presence }
    : { kind: "none" };
  return resolvePresence(a, {
    get: (name) => getConnectedSurface(name, fallbackSelectorForSurface(name)),
  });
}

/** mount 済み terminal session id を DOM placeholder から引く（single-writer 用の共有 helper）。 */
function queryMountedSessionIds(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".terminal-container")].flatMap((el) =>
    el.dataset.sessionId ? [el.dataset.sessionId] : [],
  );
}

interface TerminalPresentation {
  readonly hidden: boolean;
  readonly opacity: number;
  readonly backgroundTransparent: boolean;
}

function terminalLayoutForcesSinglePane(layout: UiLayout | null): boolean {
  const position = layout?.terminal?.position;
  return position !== undefined && position !== "default";
}

function resolveTerminalPresentation(
  layout: UiLayout | null,
  visible: boolean,
  active: boolean,
): TerminalPresentation {
  const terminalLayout = layout?.terminal;
  const layoutForcesSinglePane = terminalLayoutForcesSinglePane(layout);
  const receivesLayout = layoutForcesSinglePane ? active : visible;
  const hiddenByLayout = terminalLayout?.position === "hidden";
  const opacity =
    receivesLayout && typeof terminalLayout?.opacity === "number"
      ? Math.min(1, Math.max(0, terminalLayout.opacity))
      : 1;

  return {
    hidden: !receivesLayout || hiddenByLayout,
    opacity,
    backgroundTransparent: receivesLayout && terminalLayout?.transparentBackground === true,
  };
}

function applyTerminalPresentation(sessionId: string, presentation: TerminalPresentation): void {
  const placeholder = document.querySelector<HTMLElement>(
    `.terminal-container[data-session-id="${CSS.escape(sessionId)}"]`,
  );
  if (placeholder) {
    placeholder.dataset.presented = presentation.hidden ? "false" : "true";
  }
  const runtime = getTerminalRuntime(sessionId);
  runtime.setHidden(presentation.hidden);
  runtime.setOpacity(presentation.opacity);
  runtime.setBackgroundTransparent(presentation.backgroundTransparent);
}
// presence による sidebar 幅 mutation の単一 writer。
// --sidebar-width は host 既定 presence の内部詳細として残置（P4 で default-shell pack へ降格）。
// border width と presence-closed class も同じ writer で同期し、width=0 のリロード時に
// 1px の縦線だけが残る状態を避ける。
// 解決不能（loud-unavailable）時は一切書き込まず resolution を返す。
function applyPresenceWidth(px: number): PresenceResolution {
  const res = resolvePresenceSurface();
  if (!res.ok) return res;
  writePresenceSidebarWidth(document.documentElement, res.el, px);
  return res;
}

function resolveHostDefaultPresenceSurface(): PresenceResolution {
  const shell = getConnectedSurface("shell", ".shell-column");
  if (!shell) {
    return { ok: false, reason: "host default presence target 'shell' is not registered" };
  }
  return { ok: true, el: shell, target: "shell" };
}

function applyHostDefaultPresenceWidth(px: number): PresenceResolution {
  const res = resolveHostDefaultPresenceSurface();
  if (!res.ok) return res;
  writePresenceSidebarWidth(document.documentElement, res.el, px);
  return res;
}

function getCurrentSidebarWidth(): number {
  return readPresenceSidebarWidth(document.documentElement);
}

function isHostDefaultPresenceClosed(): boolean {
  const shell = getConnectedSurface("shell", ".shell-column");
  return getCurrentSidebarWidth() <= 0 || shell?.classList.contains("presence-closed") === true;
}

type PresenceApplyTarget = "active-ui" | "host-default";

function buildPresenceDeps(target: PresenceApplyTarget = "active-ui"): PresenceIntensityDeps {
  return {
    setSidebarWidth: (px) => {
      if (target === "host-default") {
        applyHostDefaultPresenceWidth(px);
      } else {
        applyPresenceWidth(px);
      }
    },
    getSidebarWidth: getCurrentSidebarWidth,
    // App.css の :root --sidebar-width 初期値（280px）と一致させる。
    getDefaultSidebarWidth: () => 280,
    tweenManager: getThreeRuntime().getTweenManager(),
    ambientUiRegistry: getAmbientUiPackRegistry(),
    setRenderPaused: (paused) => getThreeRuntime().setRenderPaused(paused),
    now: () => Date.now(),
    resolvePresence: () =>
      target === "host-default" ? resolveHostDefaultPresenceSurface() : resolvePresenceSurface(),
  };
}

function syncPresenceLevelStyles(level: PresenceLevel): void {
  syncPresenceClosedStyles(
    document.documentElement,
    getConnectedSurface("shell", ".shell-column"),
    level === "closed",
  );
}

function emitPresenceLevelChanged(level: PresenceLevel): void {
  window.dispatchEvent(
    new CustomEvent("yorishiro:presence-level-changed", {
      detail: { level },
    }),
  );
}

const FIRST_RUN_HEALTH_SEEN_KEY = "yorishiro:first-run-health-seen";

function FirstRunHealthPanel({
  report,
  onOpenSettings,
  onDismiss,
}: {
  readonly report: UiHealthReport;
  readonly onOpenSettings: () => void;
  readonly onDismiss: () => void;
}): React.JSX.Element {
  const title =
    report.summary === "error"
      ? "Yorishiro needs setup"
      : report.summary === "warning"
        ? "Yorishiro is almost ready"
        : "Yorishiro is ready";
  const visibleItems = report.items.filter(
    (item) => item.status !== "ok" || item.id === "agent" || item.id === "home",
  );
  const continueLabel =
    report.summary === "error" ? `Continue without ${report.selectedAgent}` : "Continue";

  return (
    <div
      className="first-run-health"
      role="dialog"
      aria-modal="true"
      aria-labelledby="health-title"
    >
      <div className="first-run-health-panel">
        <div className="first-run-health-kicker">First run check</div>
        <h1 id="health-title">{title}</h1>
        <div className="first-run-health-body">
          {visibleItems.map((item) => (
            <div className="first-run-health-row" data-status={item.status} key={item.id}>
              <span className="first-run-health-dot" aria-hidden="true" />
              <div>
                <div className="first-run-health-label">{item.label}</div>
                <div className="first-run-health-detail">{item.detail}</div>
                {item.action && <div className="first-run-health-action">{item.action}</div>}
              </div>
            </div>
          ))}
        </div>
        <div className="first-run-health-paths">
          <div>Config: {report.paths.config}</div>
          <div>Startup report: {report.paths.startupReport}</div>
        </div>
        {report.summary === "error" && (
          <div className="first-run-health-note">
            The terminal may already be trying to start in the background. Open Settings to switch
            agents or continue after reviewing the issue.
          </div>
        )}
        <div className="first-run-health-actions">
          <button
            type="button"
            className="first-run-health-secondary"
            onClick={() => {
              onOpenSettings();
              onDismiss();
            }}
          >
            Open settings
          </button>
          <button type="button" className="first-run-health-primary" onClick={onDismiss}>
            {continueLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

const clampAmbientAudioVolume = (volume: number): number =>
  Number.isFinite(volume) ? Math.max(0, Math.min(1, volume)) : 1;

const clampMotionIntensity = (value: number): number =>
  Number.isFinite(value) ? Math.max(0, Math.min(3, value)) : 1;

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
  const currentProjectRootRef = useRef<ProjectRootResolution>({ kind: "none" });
  const rememberCurrentProjectRoot = useCallback((projectRoot: ProjectRootResolution) => {
    currentProjectRootRef.current = projectRoot;
  }, []);
  const [vrmPath, setVrmPath] = useState<string | null>(() =>
    localStorage.getItem(VRM_STORAGE_KEY),
  );
  const [appLanguage, setAppLanguage] = useState<{
    configured: AppLanguage;
    resolved: ResolvedLanguage;
  }>(() => ({
    configured: "auto",
    resolved: resolveLanguage("auto", getBrowserLocales()),
  }));
  const appLanguageRef = useRef(appLanguage);
  // トップバーのボタンで全画面 UI pack を閉じるとき、stage-close を closed presence
  // （＝ターミナルだけ）へ一続きに着地させたい意思を playStage へ伝える 1-shot フラグ。
  const exitFullscreenToClosedRef = useRef(false);
  const strings = useMemo(() => getStrings(appLanguage.resolved), [appLanguage.resolved]);
  const sidebarOpen = useSidebarOpen();
  const settingsActive = useSettingsActive(SETTINGS_PACK_ID);
  // Historical debug switch. Practical tab metadata badges are allowlisted and always shown.
  const [, setTabMetadataBadgesEnabled] = useState(false);
  const [restoreDialog, setRestoreDialog] = useState<RestoreDialogRequest | null>(null);
  const restoreDialogResolveRef = useRef<((value: boolean) => void) | null>(null);
  const runtimeLevaStore = useRuntimeLevaStore();
  const activeSceneLevaStore = useActiveSceneLevaStore();

  // config write は read-modify-write なので UI / MCP 経路を 1 本の queue で直列化する。
  const pendingConfigWriteRef = useRef<Promise<void>>(Promise.resolve());
  const enqueueConfigWrite = useCallback(<T,>(write: () => Promise<T>): Promise<T> => {
    const next = pendingConfigWriteRef.current.then(write);
    pendingConfigWriteRef.current = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }, []);
  const updateYorishiroConfig = useCallback(
    (update: (current: YorishiroConfig) => YorishiroConfig): Promise<YorishiroConfig> =>
      enqueueConfigWrite(async () => {
        const cur = parseConfig(await readYorishiroConfigText());
        const updated = update(cur);
        await writeYorishiroConfigText(serializeConfig(updated));
        return updated;
      }),
    [enqueueConfigWrite],
  );
  const updateConfig = useCallback(
    (
      patch: Partial<{
        primaryPersona: string | null;
        activeScene: string | null;
        terminalAgent: string;
        ambientAudioMuted: boolean;
        ambientAudioVolume: number;
        attentionLightNotifications: boolean;
        motionIntensity: number;
        language: AppLanguage;
        voiceFrequency: VoiceFrequency;
        tabMetadataBadges: boolean;
      }>,
    ): Promise<void> => updateYorishiroConfig((cur) => ({ ...cur, ...patch })).then(() => {}),
    [updateYorishiroConfig],
  );
  const updateActiveSceneConfig = useCallback(
    (id: string | null, projectRoot: ProjectRootResolution): Promise<ProjectSceneSelectionResult> =>
      enqueueConfigWrite(async () => {
        const cur = parseConfig(await readYorishiroConfigText());
        const updated = await applyCurrentProjectSceneSelectionWithResolution(cur, projectRoot, id);
        if (updated.kind === "persisted") {
          await writeYorishiroConfigText(serializeConfig(updated.config));
        }
        return updated;
      }),
    [enqueueConfigWrite],
  );
  const setActiveSceneFromUserSelection = useCallback(
    async (id: string | null): Promise<void> => {
      const projectRoot = currentProjectRootRef.current;
      const updated = await updateActiveSceneConfig(id, projectRoot);
      rememberCurrentProjectRoot(updated.projectRoot);
      if (updated.kind === "runtime-only") {
        console.warn("[yorishiro] scene selection was not persisted", {
          warning: updated.warning,
          sceneId: id,
          projectRoot: updated.projectRoot,
        });
      }
      getSceneRegistry().setActiveScene(updated.activeScene);
    },
    [rememberCurrentProjectRoot, updateActiveSceneConfig],
  );

  const resolveRestoreDialogTarget = useCallback(async (seq: number) => {
    const locale = appLanguageRef.current.resolved;
    const localizedStrings = getStrings(locale);
    try {
      const snapshots = await snapshotList();
      const rows = buildRestoreRows(
        snapshots,
        Date.now(),
        changeStrings(localizedStrings),
        locale,
        Math.max(5, snapshots.length),
      );
      const row = rows.find((candidate) => candidate.seq === seq);
      if (row) return { changeText: row.changeText, timeText: row.timeText };
    } catch {
      // snapshot list が読めなくても restore 提案自体は続行できる。
    }
    return { changeText: `snapshot #${seq}`, timeText: "" };
  }, []);

  const openRestoreDialog = useCallback(
    async (seq: number, runRestore: () => Promise<void> = () => snapshotRestore({ seq })) => {
      const target = await resolveRestoreDialogTarget(seq);
      restoreDialogResolveRef.current?.(false);
      return new Promise<boolean>((resolve) => {
        restoreDialogResolveRef.current = resolve;
        setRestoreDialog({ seq, ...target, runRestore });
      });
    },
    [resolveRestoreDialogTarget],
  );

  const handleRestoreDialogClose = useCallback(() => {
    restoreDialogResolveRef.current?.(false);
    restoreDialogResolveRef.current = null;
    setRestoreDialog(null);
  }, []);

  const handleRestoreDialogConfirm = useCallback(async () => {
    const request = restoreDialog;
    if (request === null) return;
    await request.runRestore();
    restoreDialogResolveRef.current?.(true);
    restoreDialogResolveRef.current = null;
  }, [restoreDialog]);

  useEffect(() => {
    return () => {
      restoreDialogResolveRef.current?.(false);
      restoreDialogResolveRef.current = null;
    };
  }, []);

  const applyPresenceLevelFromApp = useCallback(
    (
      level: PresenceLevel,
      source: PresenceSource,
      options?: ApplyPresenceOptions,
      target?: PresenceApplyTarget,
    ): ApplyPresenceResult => {
      const result = applyPresenceLevel(level, source, buildPresenceDeps(target), options);
      if ("applied" in result) {
        emitPresenceLevelChanged(getPresenceState().level);
      }
      return result;
    },
    [],
  );

  const handleToggleSidebar = useCallback(() => {
    // 全画面 UI pack（theater/immersive 等、sidebar を fullscreen 占有する pack）が出ている
    // ときは、ボタンを「全画面を閉じる」操作にする。setActiveUi(null) が stage-close を
    // 再生し、exitFullscreenToClosedRef により closed presence（＝ターミナルだけ）へ一続きに
    // 着地する。閉じたあとの押下は通常どおり closed→default（普通のサイドバー表示）に戻る。
    const activeUi = getUiRegistry().getActiveUi();
    if (activeUi && layoutNeedsHostPresenceResume(activeUi.pack.layout)) {
      exitFullscreenToClosedRef.current = true;
      getUiRegistry().setActiveUi(null);
      return;
    }
    const nextLevel: PresenceLevel = sidebarOpen ? "closed" : "default";
    applyPresenceLevelFromApp(nextLevel, "settings");
  }, [applyPresenceLevelFromApp, sidebarOpen]);

  const restorePresenceFromPrompt = useCallback(() => {
    const state = getPresenceState();
    // user が settings で明示的に閉じた状態は、prompt 送信で勝手に開かない（意思を尊重）。
    // 自動復帰は住人が自分で引っ込んだ場合（source "mcp"）の「呼ばれたら顔を出す」だけ。
    if (!shouldRestorePresenceOnPrompt(state)) return;
    state.previousLevel = state.level;
    state.previousLevelSince = state.levelSince;
    if (state.level === "default") {
      state.source = "default";
      emitPresenceLevelChanged("default");
      return;
    }
    applyPresenceLevelFromApp("default", "default");
  }, [applyPresenceLevelFromApp]);

  useEffect(() => {
    appLanguageRef.current = appLanguage;
  }, [appLanguage]);

  useEffect(() => {
    const level = getPresenceState().level;
    syncPresenceLevelStyles(level);
    getThreeRuntime().setRenderPaused(level === "closed");
  }, []);

  // ── Runtime stack (HMR-surviving singleton) ─────────────────

  const runtime = getOrInit("app:runtime", () => {
    const time = new Time();
    const logger: EventBusLogger = {
      warn: (msg, meta) => console.warn(`[yorishiro] ${msg}`, meta),
      error: (msg, meta) => console.error(`[yorishiro] ${msg}`, meta),
    };
    // Generation-time 細い回路 — dev でのみ active。console mirror は長時間起動で
    // WebView 側のログ蓄積を増やすため opt-in にする。
    const mirrorDevLogToConsole =
      import.meta.env.DEV &&
      (() => {
        try {
          return localStorage.getItem("yorishiro:dev-log-console") === "1";
        } catch {
          return false;
        }
      })();
    const devLog = new DevLog({
      time,
      enabled: import.meta.env.DEV,
      sink: mirrorDevLogToConsole
        ? (entry: DevLogEntry) => {
            const tag = entry.phase ? `${entry.subsystem}:${entry.phase}` : entry.subsystem;
            console.log(`[${tag}] ${entry.note ?? ""}`, entry.data ?? "");
          }
        : undefined,
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
    registerVoiceFragment();

    const effectDispatcher = new EffectDispatcher();
    const voicePlayer = new VoicePlayer("Kyoko", new SayTtsEngine());
    const voiceApi = voicePlayer.createVoiceAPI();
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
    effectPackRunner.register(abandonedMonitorPack);
    effectPackRunner.register(screenShakePack);
    effectPackRunner.register(screenFlashPack);
    effectPackRunner.register(fireworksPack);
    effectPackRunner.register(fireworksVolleyPack);
    effectPackRunner.register(textPhysicsPack);
    effectPackRunner.register(desaturatePack);
    effectPackRunner.register(cameraMovePack);

    // Presence の hook callback は MCP/bootstrap wiring 後に有効化するため、
    // ref で late-bind する。
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
    const bundledPersonas: ReadonlyArray<{
      readonly pack: PersonaDefinition;
      readonly manifest: PersonaPackManifest;
    }> = [
      { pack: claiJaPack, manifest: claiJaManifest as PersonaPackManifest },
      { pack: claiEnPack, manifest: claiEnManifest as PersonaPackManifest },
    ];
    for (const { pack, manifest } of bundledPersonas) {
      personaRegistry.register({
        id: pack.id,
        manifest,
        persona: pack,
        origin: "bundled",
      } satisfies PersonaEntry);
      appLog.write({
        phase: "register",
        note: `registered bundled persona '${pack.id}'`,
      });
    }

    // bundled yorishiro-settings UI pack。
    uiPackRegistry.register({
      id: yorishiroSettingsPack.id,
      origin: "bundled",
      manifest: yorishiroSettingsManifest as UiPackManifest,
      pack: {
        layout: yorishiroSettingsPack.layout,
        mount: yorishiroSettingsPack.mount,
      },
    });
    appLog.write({
      phase: "register",
      note: `registered bundled UI pack '${yorishiroSettingsPack.id}'`,
    });

    // bundled immersive UI pack（chrome 隠し + キャラ全画面、terminal は背後に残る）。
    uiPackRegistry.register({
      id: immersivePack.id,
      origin: "bundled",
      manifest: immersiveManifest as UiPackManifest,
      pack: {
        layout: immersivePack.layout,
        mount: immersivePack.mount,
      },
    });
    appLog.write({
      phase: "register",
      note: `registered bundled UI pack '${immersivePack.id}'`,
    });

    // bundled theater UI pack（chrome・terminal 隠し + キャラだけ全画面）。
    uiPackRegistry.register({
      id: theaterPack.id,
      origin: "bundled",
      manifest: theaterManifest as UiPackManifest,
      pack: {
        layout: theaterPack.layout,
        mount: theaterPack.mount,
      },
    });
    appLog.write({
      phase: "register",
      note: `registered bundled UI pack '${theaterPack.id}'`,
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
    registerBundledPomodoroUi({ registry: ambientUiRegistry });
    appLog.write({
      phase: "register",
      note: "registered bundled ambient-UI packs 'attention-aura', 'pomodoro-ui'",
    });

    // ── History API（pack rollback）──────────────────────────────
    // 確認 dialog 内蔵の restore を持つ SDK instance。bundled amenity ctx に渡す。
    // MCP history_restore は 5s emit timeout を避けるため、この instance を await
    // せず proposal-only handler から UI 側 async flow へ委譲する。
    // trigger taxonomy：このインスタンスの create/snapshot は SDK 経路
    // （pack 作者の ctx.history.snapshot）からのみ呼ばれるので "sdk:snapshot"。
    // 住人 AI の MCP history_snapshot は Rust 完結で別 trigger "mcp:snapshot"
    // を打つ（P2b Task 4）。watcher 自動は "watcher-settled"、baseline は
    // "startup-baseline"。これで監査・UI でどの経路の snapshot か区別できる。
    const historyApi = createHistoryApi({
      list: () => snapshotList(),
      create: (label) => snapshotCreate({ trigger: "sdk:snapshot", label }),
      restore: (seq) => snapshotRestore({ seq }),
      confirmRestore: (seq, runRestore) => openRestoreDialog(seq, runRestore),
    });
    let ambientAudioLiveState: AmbientAudioState = { muted: false, volume: 1 };
    const ambientAudio: AmbientAudioAPI = {
      getState: () => ambientAudioLiveState,
      setMuted: (muted) => {
        ambientAudioLiveState = { ...ambientAudioLiveState, muted };
        ambientAudioEngineRef.current?.setMuted(muted);
      },
      setVolume: (volume) => {
        const clamped = clampAmbientAudioVolume(volume);
        ambientAudioLiveState = { ...ambientAudioLiveState, volume: clamped };
        ambientAudioEngineRef.current?.setMasterVolume(clamped);
      },
    };
    // user amenity の activate に渡す ctx factory。historyApi を ctx.history に通す。
    // emitEvent は発火元 pack id（registryId）を source に stamp し、複数 amenity
    // の発火元が潰れないようにする。
    const createAmenityContext = createUserAmenityContextFactory({
      tweenManager: getThreeRuntime().getTweenManager(),
      ambientAudio,
      emitEvent: (packId, name, payload) => {
        bus.emitSynthetic({ type: "system", packId }, name, payload, 0);
      },
      // pack 由来の loop announce は agent=null で観察 stream に流す（host stamp）。
      loop: (phase, detail) => perception.ingestLoopLifecycle(phase, null, detail),
      history: historyApi,
    });

    // ── Bundled amenity pack 登録（pomodoro）──────────────────────────────
    registerBundledPomodoro({
      registry: getAmenityPackRegistry(),
      tweenManager: getThreeRuntime().getTweenManager(),
      setTerminalOpacity: (value) => {
        for (const id of queryMountedSessionIds()) getTerminalRuntime(id).setOpacity(value);
      },
      getTerminalOpacity: () => {
        const ids = queryMountedSessionIds();
        return ids.length === 0 ? 1 : getTerminalRuntime(ids[0]).getOpacity();
      },
      emitEvent: (name, payload) => {
        bus.emitSynthetic({ type: "system", packId: "pomodoro" }, name, payload, 0);
      },
      loop: (phase, detail) => perception.ingestLoopLifecycle(phase, null, detail),
      history: historyApi,
    });
    appLog.write({
      phase: "register",
      note: "registered bundled amenity pack 'pomodoro'",
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
    // defaultSpec は config.defaultProfile が bundled/user profile を指していたときに
    // 構築される SpawnSpec。null なら従来の terminalAgent fallback で動く。
    let userLayerReadyResolve!: (init: {
      terminalAgent: TerminalAgent;
      defaultSpec: SpawnSpec | null;
      systemPrompt: string | null;
      pluginDir: string | null;
    }) => void;
    const userLayerReady = new Promise<{
      terminalAgent: TerminalAgent;
      defaultSpec: SpawnSpec | null;
      systemPrompt: string | null;
      pluginDir: string | null;
    }>((resolve) => {
      userLayerReadyResolve = resolve;
    });

    async function bootstrap(): Promise<void> {
      const syncAmbientUiActiveSet = (ids: ReadonlyArray<string>): void => {
        const registry = getAmbientUiPackRegistry();
        const knownIds = new Set(registry.listEntries().map((entry) => entry.id));
        const nextActive = new Set(ids.filter((id) => knownIds.has(id)));
        const currentActive = new Set(registry.getActiveSet());
        for (const id of currentActive) {
          if (!nextActive.has(id)) registry.disable(id);
        }
        for (const id of nextActive) {
          if (!currentActive.has(id)) registry.enable(id);
        }
      };

      const resyncAmbientUiActiveSetFromConfig = async (phase: string): Promise<void> => {
        try {
          const config = parseConfig(await readYorishiroConfigText());
          syncAmbientUiActiveSet(config.activeAmbientUi);
          appLog.write({
            phase,
            note: "synced active ambient-ui picks",
            data: {
              activeAmbientUi: [...config.activeAmbientUi],
              activeSet: getAmbientUiPackRegistry().getActiveSet(),
            },
          });
        } catch (err) {
          appLog.write({
            phase,
            note: "failed to sync active ambient-ui picks",
            data: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      };

      // ─ Step 1: bundled scene の asset を resolve して register（async：asset 解決） ─
      // try/catch は pack 単位。1 pack の asset 解決失敗で後続 pack の登録を巻き
      // 添えにしない（特に defaultBundledId が指す pack が先頭にあるため、
      // 一括 try だと先頭失敗で全 scene が消える）。
      const bundledScenes: ReadonlyArray<{
        readonly pack: ScenePackDefinition;
        readonly manifest: ScenePackManifest;
      }> = [
        { pack: simpleRoomPack, manifest: simpleRoomManifest as ScenePackManifest },
        { pack: mistyGrasslandsPack, manifest: mistyGrasslandsManifest as ScenePackManifest },
        { pack: abandonedFactoryPack, manifest: abandonedFactoryManifest as ScenePackManifest },
      ];
      for (const { pack, manifest } of bundledScenes) {
        try {
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
        } catch (err) {
          appLog.write({
            phase: "register",
            note: `bundled scene '${pack.id}' register failed`,
            data: { error: err instanceof Error ? err.message : String(err) },
          });
        }
      }

      // ─ Step 2: config を一度だけ読んで primaryPersona と activeScene を反映 ─
      // 旧設計は IIFE 2 つで個別に config を読んでいたが、同じ file を 2 度 parse
      // していた。1 回読み + 両 registry に流す。失敗しても次 step は続行
      // （bundled fallback で動く）。
      let terminalAgent: TerminalAgent = "claude";
      let defaultSpec: SpawnSpec | null = null;
      let ambientAudioMuted = false;
      let ambientAudioVolume = 1.0;
      let configuredLanguage: AppLanguage = "auto";
      let resolvedLanguage: ResolvedLanguage = resolveLanguage("auto", getBrowserLocales());
      let voiceFrequency: "on" | "off" = "on";
      let pluginDir: string | null = null;
      let disabledPacks: ReadonlyArray<string> = [];
      try {
        const configText = await readYorishiroConfigText();
        const config = parseConfig(configText);
        disabledPacks = config.disabledPacks;
        terminalAgent = config.terminalAgent;
        ambientAudioMuted = config.ambientAudioMuted;
        ambientAudioVolume = config.ambientAudioVolume;
        ambientAudioLiveState = { muted: ambientAudioMuted, volume: ambientAudioVolume };
        getAttentionLightSettingsStore().setEnabled(config.attentionLightNotifications);
        getThreeRuntime().setMotionIntensity(config.motionIntensity);
        voiceFrequency = config.voiceFrequency;
        setTabMetadataBadgesEnabled(config.tabMetadataBadges);
        configuredLanguage = config.language;
        resolvedLanguage = resolveLanguage(configuredLanguage, getBrowserLocales());
        appLanguageRef.current = { configured: configuredLanguage, resolved: resolvedLanguage };
        setAppLanguage({ configured: configuredLanguage, resolved: resolvedLanguage });
        appLog.write({
          phase: "language",
          note: `resolved language '${resolvedLanguage}' (configured '${configuredLanguage}')`,
        });
        try {
          pluginDir = await prepareLocalizedPluginDir({ language: resolvedLanguage });
        } catch (err) {
          appLog.write({
            phase: "language",
            note: "localized plugin dir preparation failed; falling back to bundled plugin dir",
            data: { error: err instanceof Error ? err.message : String(err) },
          });
        }
        // defaultProfile が profile を指していたら default-session の spec として使う。
        if (config.defaultProfile !== null) {
          const profile = resolveProfile(config.defaultProfile, config.profiles);
          defaultSpec = spawnSpecFromDefaultProfile(profile);
        }
        // 実起動 agent の解決は resolveEffectiveAgent に集約する（health-check と共有）。
        terminalAgent = resolveEffectiveAgent(config);
        personaRegistry.setPrimaryPersona(
          resolvePrimaryPersonaForLanguage(config.primaryPersona, resolvedLanguage),
        );
        const projectRoot = await resolveCurrentProjectRoot(cwd);
        rememberCurrentProjectRoot(projectRoot);
        scenePackRegistry.setActiveScene(
          resolveSceneForProject(config, projectRootValue(projectRoot)),
        );
        uiPackRegistry.setActiveUi(config.activeUi);
        syncAmbientUiActiveSet(config.activeAmbientUi);
      } catch (err) {
        appLog.write({
          phase: "register",
          note: "config read for primaryPersona / activeScene failed",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      // ── Bundled amenity pack 登録（music-shelf）────────────────────────────
      // default-on。ただし disable_pack で config.disabledPacks に入っている場合は
      // 起動時に active に戻さない。
      const musicShelfDefaultEnabled = !disabledPacks.includes("music-shelf");
      registerBundledMusicShelf({
        registry: getAmenityPackRegistry(),
        tweenManager: getThreeRuntime().getTweenManager(),
        emitEvent: (name, payload) => {
          bus.emitSynthetic({ type: "system", packId: "music-shelf" }, name, payload, 0);
        },
        loop: (phase, detail) => perception.ingestLoopLifecycle(phase, null, detail),
        history: historyApi,
        ambientAudio,
        defaultEnabled: musicShelfDefaultEnabled,
      });
      appLog.write({
        phase: "register",
        note: musicShelfDefaultEnabled
          ? "registered bundled amenity pack 'music-shelf'"
          : "registered bundled amenity pack 'music-shelf' (disabled by config)",
      });

      // ─ Step 2.5: subscribeActive 系 wire ─
      // 順序契約：subscribe wire は Step 2 の setActiveScene(resolvedScene)
      // より後。逆順だと bundled fallback の default scene で listener が一度
      // fire し、その直後の config 反映でもう一度 fire する double-dispatch が
      // 起きる（現状 default の simple-room は ambient:[] なので可聴ではないが、
      // 将来 default を音付き scene に変えた瞬間に boot 直後の audio pop に化ける）。
      ambientAudioEngineRef.current = initAmbientAudio(scenePackRegistry).engine;
      ambientAudio.setMuted(ambientAudioLiveState.muted);
      ambientAudio.setVolume(ambientAudioLiveState.volume);
      appLog.write({
        phase: "register",
        note: "initialized AmbientAudioRuntime",
      });
      initTerminalTheme(scenePackRegistry);
      appLog.write({
        phase: "register",
        note: "initialized terminal theme wire",
      });
      const globalPromptPromise = collectGlobalPrompt(resolvedLanguage);

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
            amenityPackRegistry: getAmenityPackRegistry(),
            effectDispatcher,
            emitEvent: (name, payload) => {
              bus.emitSynthetic({ type: "system", packId: "user-init" }, name, payload, 0);
            },
            packRegistry,
            personaDefaults: resolvedLanguage === "ja" ? claiJaPack : claiEnPack,
            userPackLog: createSubsystemLog(devLog, "UserPackLoader"),
            initScriptLog: createSubsystemLog(devLog, "InitScript"),
            tweenManager: getThreeRuntime().getTweenManager(),
            createAmenityContext,
            // init.js は hot reload される。成功したら error marker を外し、
            // 失敗時だけ marker を付けて、前の init scope が維持されていることを可視化する。
            onInitReloaded: ({ ran, missing }) => {
              void (async () => {
                try {
                  const { getCurrentWindow } = await import("@tauri-apps/api/window");
                  const win = getCurrentWindow();
                  const current = await win.title();
                  const next =
                    ran || missing
                      ? stripInitReloadErrorMarker(current)
                      : appendInitReloadErrorMarker(current);
                  if (next !== current) await win.setTitle(next);
                } catch (err) {
                  appLog.write({
                    phase: "init-reload-title",
                    note: "failed to update init.js error marker on window title",
                    data: { error: err instanceof Error ? err.message : String(err) },
                  });
                }
              })();
            },
          });
          appLog.write({
            phase: "user-layer",
            note: `user-layer ready (packs loaded=${result.packs.loaded.length} failed=${result.packs.failed.length}; init ran=${result.init.ran})`,
            data: { packs: result.packs, init: result.init },
          });
          await resyncAmbientUiActiveSetFromConfig("user-layer");
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
      userLayerReadyResolve({ terminalAgent, defaultSpec, systemPrompt, pluginDir });

      // ─ Step 4: 前回 init.js error marker を title から剥がす（独立な失敗で MCP に影響しない）─
      // native window title は webview reload を跨いで残るため、boot 時に明示的に掃除する。
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        const win = getCurrentWindow();
        const current = await win.title();
        const next = stripInitReloadErrorMarker(current);
        if (next !== current) await win.setTitle(next);
      } catch (err) {
        appLog.write({
          phase: "init-reload-title",
          note: "failed to strip init.js error marker from window title",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }

      // ─ Step 4.1: safe mode のとき window title に suffix（独立な失敗で MCP に影響しない）─
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
        const { dispatchToolEvent } = await import("./runtime/yorishiro-mcp/event-channel");
        const {
          createListPacksHandler,
          createPackDiagnoseHandler,
          createDisablePackHandler,
          createEnablePackHandler,
          createGetPackStateHandler,
          createSetPackStateHandler,
          createTerminalContextGetHandler,
          createTerminalRunsRecentHandler,
          // Phase β cosmetic write tools：
          createStateGetHandler,
          createBodyExpressionSetHandler,
          createSpaceEffectPlayHandler,
          // Phase γ motion tools：
          createBodyAnimationPlayHandler,
          createBodyMotionCancelHandler,
          createControlsGetHandler,
          createControlsSetManyHandler,
          createControlsSetHandler,
          createControlsTransitionHandler,
          // UI tween tools：
          createUiTerminalSetHandler,
          createUiSidebarSetHandler,
          createUiDebugPanelSetHandler,
          // Phase: active pack switching
          createSceneActivateHandler,
          createUiActivateHandler,
          createPersonaGoodbyeSwitchHandler,
          // Screenshot:
          createSceneScreenshotHandler,
          // Presence intensity:
          createPresenceSetIntensityHandler,
          createSetMotionIntensityHandler,
          // Voice:
          createVoiceSayHandler,
          createVoicePlayHandler,
          // Pomodoro:
          createPomodoroStartHandler,
          createPomodoroStopHandler,
          createPomodoroStatusHandler,
          // User amenity:
          createAmenityCallHandler,
          createAmenityListToolsHandler,
          createHistoryRestoreHandler,
          // Loop observation:
          createLoopAnnounceHandler,
          // Bundled pack examples:
          createBundledExampleReadHandler,
          // Attention light:
          createAttentionLightCueHandler,
        } = await import("./runtime/yorishiro-mcp/tool-handlers");
        type LoadReport = import("./runtime/user-pack-loader/load-report").LoadReport;
        type UserPackEntry = import("./runtime/user-pack-loader/user-pack-loader").UserPackEntry;
        type ToolHandlerMap = import("./runtime/yorishiro-mcp/event-channel").ToolHandlerMap;

        const readConfig = async (): Promise<YorishiroConfig> =>
          parseConfig(await readYorishiroConfigText());
        const updateConfigForMcp = (
          update: (current: YorishiroConfig) => YorishiroConfig,
        ): Promise<YorishiroConfig> => updateYorishiroConfig(update);
        const readLoadReport = async (): Promise<LoadReport | null> => {
          const text = await readLastStartupReport();
          if (text === "") return null;
          try {
            return JSON.parse(text) as LoadReport;
          } catch {
            return null;
          }
        };
        const enableBundledAmenity = (id: string): boolean => {
          const registry = getAmenityPackRegistry();
          const entry = registry
            .listEntries()
            .find((candidate) => candidate.id === id && candidate.origin === "bundled");
          if (entry === undefined) return false;
          registry.enable(id);
          return registry.getActiveSet().includes(id);
        };
        const disableBundledAmenity = (id: string): boolean => {
          const registry = getAmenityPackRegistry();
          const entry = registry
            .listEntries()
            .find((candidate) => candidate.id === id && candidate.origin === "bundled");
          if (entry === undefined) return false;
          registry.disable(id);
          return true;
        };
        // disable/enable で fs から読み直して runtime registry に register し直す経路。
        const userPackLog = createSubsystemLog(devLog, "UserPackLoader");
        const reloadPack = async (id: string): Promise<{ ok: boolean; reason?: string }> => {
          return reloadSingleUserPack(id, {
            effectPackRunner,
            personaRegistry,
            scenePackRegistry,
            uiPackRegistry,
            ambientUiPackRegistry: getAmbientUiPackRegistry(),
            amenityPackRegistry: getAmenityPackRegistry(),
            packRegistry,
            userPackLog,
            createAmenityContext,
          });
        };
        const readBundledPacks = (): Array<{ id: string; kind: string }> => [
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
            abandonedMonitorPack,
            cameraMovePack,
            desaturatePack,
            fireworksPack,
            fireworksVolleyPack,
            screenShakePack,
            textPhysicsPack,
          ].map((p) => ({ id: p.id, kind: "effect" })),
          ...getAmbientUiPackRegistry()
            .listEntries()
            .filter((e) => e.origin === "bundled")
            .map((e) => ({ id: e.id, kind: "ambient-ui" })),
          ...getAmenityPackRegistry()
            .listEntries()
            .filter((e) => e.origin === "bundled")
            .map((e) => ({ id: e.id, kind: "amenity" })),
        ];

        const handlers: ToolHandlerMap = {
          "list-packs": createListPacksHandler({
            readRegistry: () => packRegistry.listEntries(),
            readBundledPacks,
            readConfig,
            readLoadReport,
            getActiveIds: () => ({
              scene: scenePackRegistry.getActiveSceneId(),
              ui: uiPackRegistry.getActiveUiId(),
              persona: personaRegistry.getActivePersonaId(),
              ambientUi: getAmbientUiPackRegistry().getActiveSet(),
              amenity: getAmenityPackRegistry().getActiveSet(),
            }),
          }),
          "pack-diagnose": createPackDiagnoseHandler({
            readRegistry: () => packRegistry.listEntries(),
            readBundledPacks,
            readConfig,
            readLoadReport,
            getActiveIds: () => ({
              scene: scenePackRegistry.getActiveSceneId(),
              ui: uiPackRegistry.getActiveUiId(),
              persona: personaRegistry.getActivePersonaId(),
              ambientUi: getAmbientUiPackRegistry().getActiveSet(),
              amenity: getAmenityPackRegistry().getActiveSet(),
            }),
            readUserPackEntries: async () => invoke<UserPackEntry[]>("list_user_packs"),
          }),
          "disable-pack": createDisablePackHandler({
            updateConfig: updateConfigForMcp,
            registry: packRegistry,
            disableBundledAmenity,
          }),
          "enable-pack": createEnablePackHandler({
            updateConfig: updateConfigForMcp,
            reloadPack,
            enableBundledAmenity,
          }),
          "history-restore": createHistoryRestoreHandler({
            proposeRestore: (seq) => {
              void openRestoreDialog(seq);
            },
          }),
          "amenity.call": createAmenityCallHandler({
            amenityPackRegistry: getAmenityPackRegistry(),
          }),
          "amenity.list-tools": createAmenityListToolsHandler({
            amenityPackRegistry: getAmenityPackRegistry(),
          }),
          "get-ui-state": createGetPackStateHandler({
            state: uiState,
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
          }),
          "set-ui-state": createSetPackStateHandler({
            state: uiState,
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
          }),
          "terminal.context.get": createTerminalContextGetHandler({
            getLatestRegionContext: () =>
              getTerminalRuntime(tabManager.getState().activeSessionId).getLatestRegionContext(),
            getTerminalReferences: () =>
              getAllTerminalRuntimes().flatMap((runtime) => runtime.getTerminalReferences()),
          }),
          "terminal.runs.recent": createTerminalRunsRecentHandler({
            getCommandRuns: () =>
              getAllTerminalRuntimes().flatMap((runtime) => runtime.getCommandRunsRecent()),
            getTerminalReferences: () =>
              getAllTerminalRuntimes().flatMap((runtime) => runtime.getTerminalReferences()),
            getProblems: (sessionId, runId) =>
              getTerminalRuntime(sessionId).getCommandRunProblems(runId),
            getTimeline: () =>
              mergeRunTimeline({
                commandRuns: getAllTerminalRuntimes().flatMap((runtime) =>
                  runtime.getCommandRunsRecent(),
                ),
                agentToolRuns: getAgentToolRunStore().getRecent(),
                loopRuns: getLoopRunStore()
                  .getRecent()
                  .map((run) => ({ ...run, sessionId: run.agent ?? "loop" })),
              }),
          }),
          "controls.get": createControlsGetHandler({
            getSceneStore: () => getActiveSceneLevaStore(),
            getCommonStore: () => getRuntimeLevaStore(),
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
          }),
          "controls.set": createControlsSetHandler({
            getSceneStore: () => getActiveSceneLevaStore(),
            getCommonStore: () => getRuntimeLevaStore(),
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
            tweenManager: getThreeRuntime().getTweenManager(),
            onControlSet: ({ scope, path, value }) => {
              if (scope === "common") applyCommonCameraControlSet(path, value);
            },
          }),
          "controls.set_many": createControlsSetManyHandler({
            getSceneStore: () => getActiveSceneLevaStore(),
            getCommonStore: () => getRuntimeLevaStore(),
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
            tweenManager: getThreeRuntime().getTweenManager(),
            onControlSet: ({ scope, path, value }) => {
              if (scope === "common") applyCommonCameraControlSet(path, value);
            },
          }),
          "controls.transition": createControlsTransitionHandler({
            getSceneStore: () => getActiveSceneLevaStore(),
            getCommonStore: () => getRuntimeLevaStore(),
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
            tweenManager: getThreeRuntime().getTweenManager(),
            onControlSet: ({ scope, path, value }) => {
              if (scope === "common") applyCommonCameraControlSet(path, value);
            },
          }),
          // ── Phase β cosmetic write tools ────────────────────────
          "state.get": createStateGetHandler({
            readConfig,
            getCamera: () => getThreeRuntime().getCamera(),
            getVrm: () => getThreeRuntime().getVrm(),
            getBody: () => getThreeRuntime().getBody(),
            tweenManager: getThreeRuntime().getTweenManager(),
            getSidebarWidth: getCurrentSidebarWidth,
            getTerminalOpacity: () => {
              const ids = queryMountedSessionIds();
              return ids.length === 0 ? 1 : getTerminalRuntime(ids[0]).getOpacity();
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
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
            uiState,
          }),
          "body.expression.set": createBodyExpressionSetHandler({
            getBody: () => getThreeRuntime().getBody(),
          }),
          "space.effect.play": createSpaceEffectPlayHandler({
            effectDispatcher,
          }),
          // ── Phase γ motion tools ────────────────────────
          "body.animation.play": createBodyAnimationPlayHandler({
            getBody: () => getThreeRuntime().getBody(),
          }),
          "body.motion.cancel": createBodyMotionCancelHandler(),
          // ── UI tween tools ─────────────────────────────────
          "ui.terminal.set": createUiTerminalSetHandler({
            setTerminalOpacity: (value) => {
              for (const id of queryMountedSessionIds()) getTerminalRuntime(id).setOpacity(value);
            },
            getTerminalOpacity: () => {
              const ids = queryMountedSessionIds();
              return ids.length === 0 ? 1 : getTerminalRuntime(ids[0]).getOpacity();
            },
            tweenManager: getThreeRuntime().getTweenManager(),
          }),
          "ui.sidebar.set": createUiSidebarSetHandler({
            setSidebarWidth: (px) => {
              applyPresenceWidth(px);
            },
            getSidebarWidth: getCurrentSidebarWidth,
            getDefaultSidebarWidth: () => 280,
            getWindowSize: () => ({
              width: window.innerWidth,
              height: window.innerHeight,
            }),
            tweenManager: getThreeRuntime().getTweenManager(),
            precheckPresence: () => resolvePresenceSurface(),
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
            setActiveScene: setActiveSceneFromUserSelection,
            getActiveSceneId: () => scenePackRegistry.getActiveSceneId(),
          }),
          "ui.activate": createUiActivateHandler({
            registry: uiPackRegistry,
          }),
          "persona.goodbye-switch": createPersonaGoodbyeSwitchHandler({
            updateConfig: updateConfigForMcp,
            beginCurtainReload,
            listPersonaIds: () => personaRegistry.listEntries().map((entry) => entry.id),
            reloadPack,
          }),
          // ── Screenshot ────────────────────────────────────
          "scene.screenshot": createSceneScreenshotHandler({
            getCamera: () => getThreeRuntime().getCamera(),
            getScene: () => getThreeRuntime().getScene(),
            getRenderer: () => getThreeRuntime().getRenderer(),
            claimCamera: () => claimState.claim("camera"),
            onAfterCapture: () => {
              effectDispatcher.dispatch({ kind: "screen-flash" });
            },
          }),
          // ── Presence intensity ────────────────────────────
          "presence.set-intensity": createPresenceSetIntensityHandler({
            applyPresenceLevel: (level, source) => applyPresenceLevelFromApp(level, source),
          }),
          "motion.set-intensity": createSetMotionIntensityHandler({
            updateConfig: updateConfigForMcp,
            applyToRuntime: (intensity) => getThreeRuntime().setMotionIntensity(intensity),
          }),
          // ── Voice ─────────────────────────────────────────
          "voice.say": createVoiceSayHandler({
            speak: (text) => {
              voiceApi.say(text);
            },
            getFrequency: () => voiceFrequency,
          }),
          "voice.play": createVoicePlayHandler({
            play: (clipRef, options) => {
              voiceApi.play(clipRef, options);
            },
            getFrequency: () => voiceFrequency,
          }),
          // ── Pomodoro ─────────────────────────────────────
          "pomodoro.start": createPomodoroStartHandler({
            amenityPackRegistry: getAmenityPackRegistry(),
          }),
          "pomodoro.stop": createPomodoroStopHandler({
            amenityPackRegistry: getAmenityPackRegistry(),
          }),
          "pomodoro.status": createPomodoroStatusHandler({
            amenityPackRegistry: getAmenityPackRegistry(),
          }),
          // ── Loop observation ─────────────────────────────
          // 住人 AI が自律ループの phase を自己申告する。観察 stream に流すだけ。
          // agent 帰属は host（= 起動中の terminalAgent）が stamp する。
          "loop.announce": createLoopAnnounceHandler({
            ingest: (phase, agent, detail) => perception.ingestLoopLifecycle(phase, agent, detail),
            getAgentKind: () => terminalAgent,
          }),
          // ── Bundled pack examples ───────────────────────────
          "bundled-example.read": createBundledExampleReadHandler({
            readBundledPackSource: (id) => invoke("read_bundled_pack_source", { id }),
          }),
          // ── Attention light ──────────────────────────────
          "attention.light.cue": createAttentionLightCueHandler({
            trigger: () => getAttentionLightCueStore().triggerManual(),
          }),
        };

        // Perception の presence callback を late-bind する。
        presenceRestoreRef.current = (): void => {
          restorePresenceFromPrompt();
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
        const done = await checkTutorialDone();
        if (!done) {
          setTimeout(async () => {
            try {
              const config = parseConfig(await readYorishiroConfigText());
              await ptyWrite({
                data: resolveFixedTerminalPrompt(
                  "tutorial",
                  appLanguageRef.current.resolved,
                  config.terminalAgent,
                ),
              });
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
      userLayerReadyResolve({
        terminalAgent: "claude",
        defaultSpec: null,
        systemPrompt: null,
        pluginDir: null,
      });
    });

    return {
      time,
      bus,
      dispatcher,
      perception,
      logBridge,
      devLog,
      effectDispatcher,
      effectPackRunner,
      voicePlayer,
      scenePackRegistry,
      uiPackRegistry,
      packRegistry,
      claimState,
      uiState,
      userLayerReady,
      createAmenityContext,
      ambientAudio,
    };
  });

  const {
    perception,
    dispatcher,
    logBridge,
    devLog,
    effectDispatcher,
    effectPackRunner,
    voicePlayer,
    scenePackRegistry,
    uiPackRegistry,
    packRegistry,
    claimState,
    uiState,
    time,
    userLayerReady,
    createAmenityContext,
    ambientAudio,
  } = runtime;

  // user layer load（bundled + user pack 登録、primaryPersona 反映）完了を待ってから
  // Terminal を mount する。これで coding agent の PTY spawn は確定した primaryPersona の
  // prompt overlay で 1 回だけ走る（多重 spawn / null prompt race を回避）。
  const [isUserLayerReady, setIsUserLayerReady] = useState(false);
  // project 切替 reload 専用の暗転フェード。Cmd+R や error boundary の reload は対象外。
  const { phase: reloadCurtainPhase, beginCurtainReload } = useReloadCurtain(isUserLayerReady);
  const [terminalAgent, setTerminalAgent] = useState<TerminalAgent>("claude");
  const [defaultSpec, setDefaultSpec] = useState<SpawnSpec | null>(null);
  // undefined = まだ未解決、null = 空（非注入）、string = 注入する内容。
  const [resolvedSystemPrompt, setResolvedSystemPrompt] = useState<string | null | undefined>(
    undefined,
  );
  const [localizedPluginDir, setLocalizedPluginDir] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    userLayerReady.then(({ terminalAgent: agent, defaultSpec: spec, systemPrompt, pluginDir }) => {
      if (!cancelled) {
        setTerminalAgent(agent);
        setDefaultSpec(spec);
        setResolvedSystemPrompt(systemPrompt);
        setLocalizedPluginDir(pluginDir);
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
            cwdPersistence: createSessionTabCwdPersistence(window.localStorage),
            onEvent: (name, payload) => {
              runtime.bus.emitSynthetic(
                { type: "system", packId: "yorishiro:session-tabs" },
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
  const sessionStatusStore = useMemo(() => getSessionStatusStore(), []);
  const [sessionStatuses, setSessionStatuses] = useState<ReadonlyArray<SessionStatus>>(() =>
    sessionStatusStore.list(),
  );
  const [sessionHookBadges, setSessionHookBadges] = useState<
    ReadonlyMap<string, TabIndicatorBadge>
  >(() => new Map());
  const sessionHookBadgeTimersRef = useRef<Map<string, number>>(new Map());
  const [isSessionRestoreReady, setIsSessionRestoreReady] = useState(false);
  const visibleTerminalSessionIdSet = useMemo(
    () => new Set<SessionId>([tabState.activeSessionId]),
    [tabState.activeSessionId],
  );
  const visibleTerminalSessionIdSetRef = useRef(visibleTerminalSessionIdSet);
  visibleTerminalSessionIdSetRef.current = visibleTerminalSessionIdSet;
  const activeUiLayoutRef = useRef<UiLayout | null>(null);
  const preferredActiveSessionIdRef = useRef<string | null | undefined>(undefined);
  if (preferredActiveSessionIdRef.current === undefined) {
    preferredActiveSessionIdRef.current = localStorage.getItem(ACTIVE_SESSION_STORAGE_KEY);
  }

  const applyTerminalPresentationForSession = useCallback(
    (sessionId: SessionId, layout: UiLayout | null = activeUiLayoutRef.current) => {
      applyTerminalPresentation(
        sessionId,
        resolveTerminalPresentation(
          layout,
          visibleTerminalSessionIdSetRef.current.has(sessionId),
          tabManager.getState().activeSessionId === sessionId,
        ),
      );
    },
    [tabManager],
  );

  const applyTerminalPresentationForMountedSessions = useCallback(
    (layout: UiLayout | null = activeUiLayoutRef.current) => {
      for (const sessionId of queryMountedSessionIds()) {
        applyTerminalPresentationForSession(sessionId, layout);
      }
    },
    [applyTerminalPresentationForSession],
  );

  useEffect(() => {
    return tabManager.subscribe(setTabState);
  }, [tabManager]);

  useEffect(() => {
    return sessionStatusStore.subscribe(() => {
      setSessionStatuses(sessionStatusStore.list());
    });
  }, [sessionStatusStore]);

  useEffect(() => {
    const liveSessionIds = new Set(tabState.sessions);
    for (const sessionId of tabState.sessions) {
      sessionStatusStore.register(sessionId);
    }
    for (const status of sessionStatusStore.list()) {
      if (!liveSessionIds.has(status.sessionId)) {
        sessionStatusStore.remove(status.sessionId);
      }
    }
    sessionStatusStore.markActive(tabState.activeSessionId);
  }, [sessionStatusStore, tabState.activeSessionId, tabState.sessions]);

  const sessionStatusById = useMemo(
    () => new Map(sessionStatuses.map((status) => [status.sessionId, status] as const)),
    [sessionStatuses],
  );

  const showSessionHookBadge = useCallback((sessionId: string, badge: TabIndicatorBadge) => {
    const currentTimer = sessionHookBadgeTimersRef.current.get(sessionId);
    if (currentTimer !== undefined) {
      window.clearTimeout(currentTimer);
    }
    setSessionHookBadges((prev) => {
      const next = new Map(prev);
      next.set(sessionId, badge);
      return next;
    });
    const timer = window.setTimeout(() => {
      sessionHookBadgeTimersRef.current.delete(sessionId);
      setSessionHookBadges((prev) => {
        if (!prev.has(sessionId)) return prev;
        const next = new Map(prev);
        next.delete(sessionId);
        return next;
      });
    }, HOOK_BADGE_VISIBLE_MS);
    sessionHookBadgeTimersRef.current.set(sessionId, timer);
  }, []);

  useEffect(() => {
    return () => {
      for (const timer of sessionHookBadgeTimersRef.current.values()) {
        window.clearTimeout(timer);
      }
      sessionHookBadgeTimersRef.current.clear();
    };
  }, []);

  useEffect(() => {
    const subscription = runtime.bus.subscribeDispatch((event) => {
      const state = tabManager.getState();
      const attentionDecision = deriveSessionTabStatusAttention(event, state);
      if (attentionDecision?.action === "mark-loop-blocked") {
        sessionStatusStore.markAttentionRequest(
          attentionDecision.sessionId,
          attentionDecision.notification,
        );
      } else if (attentionDecision?.action === "clear-loop-blocked") {
        sessionStatusStore.clearLoopAttention(attentionDecision.sessionId);
      }

      const badgeDecision = deriveSessionTabMetadataBadge(event, state);
      if (badgeDecision === null) return;
      showSessionHookBadge(badgeDecision.sessionId, badgeDecision.badge);
    });
    return () => subscription.dispose();
  }, [runtime.bus, sessionStatusStore, showSessionHookBadge, tabManager]);

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
    applyTerminalPresentationForMountedSessions();
  }, [tabState.activeSessionId, applyTerminalPresentationForMountedSessions]);

  const canMountTerminals =
    isUserLayerReady && isSessionRestoreReady && resolvedSystemPrompt !== undefined;
  const getTerminalSpec = useCallback(
    (sessionId: SessionId): SpawnSpec => {
      if (sessionId !== DEFAULT_SESSION_ID) {
        return { kind: "shell", integration: true };
      }
      return withAgentRuntimeFields(
        defaultSpec ?? {
          kind: "agent",
          agent: terminalAgent,
        },
        resolvedSystemPrompt ?? null,
        localizedPluginDir,
      );
    },
    [defaultSpec, terminalAgent, resolvedSystemPrompt, localizedPluginDir],
  );
  const getSessionCwd = useCallback(
    (sessionId: SessionId) => tabManager.getSessionLaunchCwd(sessionId),
    [tabManager],
  );
  const getInterruptProtectionMode = useCallback(
    (sessionId: SessionId, spec: SpawnSpec) =>
      sessionId === DEFAULT_SESSION_ID ? resolveInterruptProtectionModeForSpawnSpec(spec) : "none",
    [],
  );
  const shouldAttachExistingSession = useCallback(
    (sessionId: SessionId) => tabManager.shouldAttachExistingSession(sessionId),
    [tabManager],
  );
  const handleTerminalActivate = useCallback(
    (sessionId: SessionId) => tabManager.switchTo(sessionId),
    [tabManager],
  );

  // scene 変更時に全 session の terminal テーマを更新する。
  // initTerminalTheme は current theme と CSS vars の更新だけを担当するため、
  // 既に mount 済みの各 TerminalRuntime へここで即時適用する。
  useEffect(() => {
    if (!isUserLayerReady) return;
    const sub = scenePackRegistry.subscribeActive((scene) => {
      const theme = syncCurrentTerminalTheme(scene);
      for (const sessionId of tabManager.getState().sessions) {
        const rt = getTerminalRuntime(sessionId);
        rt.setTheme(theme);
        rt.refit();
        void sessionRefreshTheme({ sessionId }).catch((err) => {
          console.warn("[terminal-theme] failed to refresh agent theme:", err);
        });
      }
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
  // scene 切替で override をリセット。scene が表現を握る原則。
  // 共通管理の Camera は跨いで持ち越すが、scene-scoped の調整（layer blur 等）は
  // scene と一緒に切り替わる。
  // docs/decisions/scene-layer-override-semantics.md
  const activeSceneId = activeSceneEntry?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: activeSceneId は effect 本体では読まないが、scene 切替の trigger として意図的に dep に含める
  useEffect(() => {
    setSceneLayerOverrides([]);
  }, [activeSceneId]);
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
  // （philosophy: docs/philosophy/PHILOSOPHY.md 「観察の境界」）。
  const personaRegistry = getPersonaRegistry();
  const [primaryPersonaState, setPrimaryPersonaState] = useState<PersonaDefinition | null>(() =>
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

  const bundledManifestMap = useMemo(
    () =>
      new Map(
        [
          claiEnManifest,
          claiJaManifest,
          abandonedFactoryManifest,
          mistyGrasslandsManifest,
          simpleRoomManifest,
          yorishiroSettingsManifest,
          immersiveManifest,
          theaterManifest,
          abandonedMonitorManifest,
          cameraMoveManifest,
          desaturateManifest,
          fireworksManifest,
          fireworksVolleyManifest,
          screenShakeManifest,
          textPhysicsManifest,
          attentionAuraManifest,
          pomodoroUiManifest,
          pomodoroManifest,
          musicShelfManifest,
        ].map((m) => [m.id, m] as const),
      ),
    [],
  );

  const readBundledPacks = useCallback(() => {
    const withMeta = (id: string, kind: string) => {
      const m = bundledManifestMap.get(id) as Record<string, unknown> | undefined;
      return {
        id,
        kind,
        description: m?.description as string | undefined,
        author: m?.author as string | undefined,
      };
    };
    return [
      ...personaRegistry
        .listEntries()
        .filter((e) => e.origin === "bundled")
        .map((e) => withMeta(e.id, "persona")),
      ...scenePackRegistry
        .listEntries()
        .filter((e) => e.origin === "bundled")
        .map((e) => withMeta(e.id, "scene")),
      ...uiPackRegistry
        .listEntries()
        .filter((e) => e.origin === "bundled")
        .map((e) => withMeta(e.id, "ui")),
      ...[
        abandonedMonitorPack,
        cameraMovePack,
        desaturatePack,
        fireworksPack,
        fireworksVolleyPack,
        screenShakePack,
        textPhysicsPack,
      ].map((p) => withMeta(p.id, "effect")),
      ...getAmbientUiPackRegistry()
        .listEntries()
        .filter((e) => e.origin === "bundled")
        .map((e) => withMeta(e.id, "ambient-ui")),
      ...getAmenityPackRegistry()
        .listEntries()
        .filter((e) => e.origin === "bundled")
        .map((e) => withMeta(e.id, "amenity")),
    ];
  }, [bundledManifestMap, personaRegistry, scenePackRegistry, uiPackRegistry]);

  const listPacksForHealth = useCallback(async () => {
    const { createListPacksHandler } = await import("./runtime/yorishiro-mcp/tool-handlers");
    const result = await createListPacksHandler({
      readRegistry: () => packRegistry.listEntries(),
      readBundledPacks,
      readConfig: async () => parseConfig(await readYorishiroConfigText()),
      readLoadReport: async () => {
        const text = await readLastStartupReport();
        if (text === "") return null;
        try {
          return JSON.parse(text);
        } catch {
          return null;
        }
      },
      getActiveIds: () => ({
        scene: scenePackRegistry.getActiveSceneId(),
        ui: uiPackRegistry.getActiveUiId(),
        persona: personaRegistry.getActivePersonaId(),
        ambientUi: getAmbientUiPackRegistry().getActiveSet(),
        amenity: getAmenityPackRegistry().getActiveSet(),
      }),
    })({});
    type UserPackEntry = import("./runtime/user-pack-loader/user-pack-loader").UserPackEntry;
    const userEntries = await invoke<UserPackEntry[]>("list_user_packs").catch(() => []);
    return {
      packs: result.packs.flatMap((pack) => {
        if (pack.status !== "disabled" || pack.kind !== "") return [pack];
        const matchingEntries = userEntries.filter((entry) => entry.id === pack.id);
        if (matchingEntries.length === 0) return [pack];
        return matchingEntries.map((entry) => ({ ...pack, kind: entry.kind }));
      }),
    };
  }, [packRegistry, personaRegistry, scenePackRegistry, uiPackRegistry, readBundledPacks]);

  const collectAppHealthReport = useCallback(
    () => collectHealthReport({ listPacks: listPacksForHealth }),
    [listPacksForHealth],
  );

  const [firstRunHealth, setFirstRunHealth] = useState<UiHealthReport | null>(null);

  useEffect(() => {
    if (!isUserLayerReady) return;
    if (localStorage.getItem(FIRST_RUN_HEALTH_SEEN_KEY) === "1") return;
    let cancelled = false;
    void collectAppHealthReport().then((report) => {
      if (!cancelled) setFirstRunHealth(report);
    });
    return () => {
      cancelled = true;
    };
  }, [isUserLayerReady, collectAppHealthReport]);

  const dismissFirstRunHealth = useCallback(() => {
    localStorage.setItem(FIRST_RUN_HEALTH_SEEN_KEY, "1");
    setFirstRunHealth(null);
  }, []);

  // ── UI pack: subscribe + mount / dispose lifecycle ────────────────────
  // active UI pack が切り替わるたびに前の pack を teardown（dispose + container remove +
  // layout reset）してから新しい pack の layout を apply、container を body 直下に挿入、
  // mount を呼ぶ。Terminal / Sidebar / charactor-container が DOM に生えるまでは
  // subscribe 自体を遅延させる（querySelector が null を返す事故の回避）。
  //
  // container は React tree 外（document.body 直下）：pack が描画する overlay を
  // Yorishiro 本体の layout と独立にするため。pointer-events: none で default 透過し、
  // pack 側で auto を明示した要素だけがクリックを受ける。
  useEffect(() => {
    // Terminal が mount されるまでは subscribe しない（空振り事故防止）。
    // bundled register は factory 内の同期 code なので、ここに到達した時点で registry は既に埋まっている。
    if (!isUserLayerReady) return;

    let currentDisposable: Disposable | null = null;
    let currentContainer: HTMLDivElement | null = null;
    let currentAbort: AbortController | null = null;
    let currentLayout: UiLayout | null = null;
    const setCurrentLayout = (layout: UiLayout | null): void => {
      currentLayout = layout;
      activeUiLayoutRef.current = layout;
    };

    const makeLayoutTargets = (terminal: HTMLElement): LayoutTargets | null => {
      const sidebar = getConnectedSurface("shell", ".shell-column");
      const character = getConnectedSurface("character", ".charactor-container");
      // "chrome" surface は Sidebar が自己登録する（P3）。未登録時は DOM class ".sidebar" にフォールバック
      const chrome = getConnectedSurface("chrome", ".sidebar");
      if (!sidebar || !character || !chrome) return null;
      // tab-indicator は常時存在するとは限らない（タブ未描画時）ので optional。
      const tabIndicator = document.querySelector<HTMLElement>(".tab-indicator") ?? undefined;
      return {
        root: document.documentElement,
        terminal,
        sidebar,
        character,
        chrome,
        tabIndicator,
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

    // stage 遷移（chrome 引っ込み → ステージ全画面）で動かす surface 群。
    const getStageSurfaces = (): StageSurfaces | null => {
      const shell = getConnectedSurface("shell", ".shell-column");
      const character = getConnectedSurface("character", ".charactor-container");
      const chrome = getConnectedSurface("chrome", ".sidebar");
      if (!shell || !character || !chrome) return null;
      return { shell, character, chrome };
    };

    // closed を確定する：width 0 / presence-closed / render pause / level=closed / event 発火。
    // 全画面 pack をボタンで閉じたあとの「ターミナルだけ」着地に使う。
    const settlePresenceClosed = () => {
      // 着地直前に別の UI pack が出ていたら何もしない（その pack の状態を尊重）。
      if (getUiRegistry().getActiveUiId() !== null) return;
      applyPresenceLevelFromApp("closed", "settings", { immediate: true }, "host-default");
      syncPresenceLevelStyles("closed");
    };

    const playStage = (direction: "open" | "close", exitToClosed = false) => {
      const surfaces = getStageSurfaces();
      if (!surfaces) return;
      // exitToClosed のときだけ、closed presence（ターミナルだけ）へ一続きに畳む。
      // それ以外（F3 トグル等）は従来どおり 280（サイドバー表示）へ。
      const toClosed = direction === "close" && exitToClosed;
      if (toClosed) {
        // inline width クリア後の着地点を CSS 0 にして、フルスクリーン→0 を途切れず見せる。
        // presence-closed クラス（display:none）はアニメ中は付けない——付けると shell-column が
        // 消えて閉じアニメが見えなくなる。完了後に settlePresenceClosed で正式に確定する。
        syncPresenceClosedStyles(document.documentElement, null, true);
      }
      const transition = playStageTransition(direction, surfaces, {
        tweenManager: getThreeRuntime().getTweenManager(),
        viewportWidth: () => window.innerWidth,
        closeCollapsedWidthPx: toClosed ? 0 : undefined,
      });
      if (toClosed) {
        void transition.then(settlePresenceClosed);
      } else {
        void transition;
      }
    };

    const refitPresentedTerminals = () => {
      for (const sessionId of getMountedSessionIds()) {
        const presentation = resolveTerminalPresentation(
          currentLayout,
          visibleTerminalSessionIdSetRef.current.has(sessionId),
          tabManager.getState().activeSessionId === sessionId,
        );
        if (!presentation.hidden) getTerminalRuntime(sessionId).refit();
      }
    };

    // mount 済み terminal の session id を placeholder の data-session-id から引く。
    // layout target の収集と同じ source なので食い違わない。
    const getMountedSessionIds = (): string[] => queryMountedSessionIds();

    const resetLayoutForAllTerminals = (): boolean => {
      const targetsList = getAllLayoutTargets();
      for (const targets of targetsList) resetLayout(targets);
      // singleton xterm を layout-hidden から復帰させる（placeholder の
      // display 解除だけでは per-frame visibility 強制が解けないため）。
      // opacity も既定（完全不透明）へ、背景透明化も解除する。
      // 非表示 session は hidden を維持する（重なり防止）。
      for (const sessionId of getMountedSessionIds()) {
        applyTerminalPresentationForSession(sessionId, null);
      }
      return targetsList.length > 0;
    };

    const applyLayoutForAllTerminals = (layout: UiLayout): LayoutTargets | null => {
      const targetsList = getAllLayoutTargets();
      for (const targets of targetsList) applyLayout(layout, targets);
      // placeholder の display:none だけでは body 直下の singleton xterm を
      // 隠せない（syncAttachedRect が毎フレーム visibility を上書きする）。
      // setHidden で runtime 側のフラグを立てて確実に隠す。
      for (const sessionId of getMountedSessionIds()) {
        applyTerminalPresentationForSession(sessionId, layout);
      }
      return getLayoutTargets() ?? targetsList[0] ?? null;
    };

    /**
     * activeAmbientUi を read-modify-write で更新する config helper。
     * withActiveAmbientUiSet を使って config を immutable に更新し、
     * registry 側の enable/disable も同期する。
     */
    const updateActiveAmbientUi = (ids: readonly string[]): Promise<void> =>
      enqueueConfigWrite(async () => {
        const cur = parseConfig(await readYorishiroConfigText());
        const updated = withActiveAmbientUiSet(cur, ids);
        await writeYorishiroConfigText(serializeConfig(updated));

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

    const readLoadReportForPackTools = async () => {
      const text = await readLastStartupReport();
      if (text === "") return null;
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    };

    const readUserPackEntriesForPackTools = async () => {
      type UserPackEntry = import("./runtime/user-pack-loader/user-pack-loader").UserPackEntry;
      return invoke<UserPackEntry[]>("list_user_packs");
    };

    const reloadPackForPackTools = async (
      id: string,
    ): Promise<{ ok: boolean; reason?: string }> => {
      return reloadSingleUserPack(id, {
        effectPackRunner,
        personaRegistry,
        scenePackRegistry,
        uiPackRegistry,
        ambientUiPackRegistry: getAmbientUiPackRegistry(),
        amenityPackRegistry: getAmenityPackRegistry(),
        packRegistry,
        userPackLog: createSubsystemLog(devLog, "UserPackLoader"),
        createAmenityContext,
      });
    };

    const enableBundledAmenityForPackTools = (id: string): boolean => {
      const registry = getAmenityPackRegistry();
      const entry = registry
        .listEntries()
        .find((candidate) => candidate.id === id && candidate.origin === "bundled");
      if (entry === undefined) return false;
      registry.enable(id);
      return registry.getActiveSet().includes(id);
    };
    const disableBundledAmenityForPackTools = (id: string): boolean => {
      const registry = getAmenityPackRegistry();
      const entry = registry
        .listEntries()
        .find((candidate) => candidate.id === id && candidate.origin === "bundled");
      if (entry === undefined) return false;
      registry.disable(id);
      return true;
    };

    const buildPackToolDeps = () => ({
      readRegistry: () => packRegistry.listEntries(),
      readBundledPacks,
      readConfig: async () => parseConfig(await readYorishiroConfigText()),
      updateConfig: updateYorishiroConfig,
      readLoadReport: readLoadReportForPackTools,
      getActiveIds: () => ({
        scene: scenePackRegistry.getActiveSceneId(),
        ui: uiPackRegistry.getActiveUiId(),
        persona: personaRegistry.getActivePersonaId(),
        ambientUi: getAmbientUiPackRegistry().getActiveSet(),
        amenity: getAmenityPackRegistry().getActiveSet(),
      }),
    });

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
            setCurrentLayout(layout);
            refitPresentedTerminals();
          },
        },
        app: {
          setVrm: (path: string | null) => applyVrmPath(path),
          // host 所有の固定プロンプトのみ解決して pre-fill する（pack はバイトを
          // 選べない）。改行なし＝user が Enter するまで実行されない。
          // 設計境界: docs/decisions/input-prefill-boundary.md
          insertFixedPrompt: async (key) => {
            const config = parseConfig(await readYorishiroConfigText());
            const data = resolveFixedTerminalPrompt(
              key,
              appLanguageRef.current.resolved,
              config.terminalAgent,
            );
            await ptyWrite({ data });
          },
          insertPackRepairPrompt: async (id, kind, action) => {
            const config = parseConfig(await readYorishiroConfigText());
            const data = resolvePackRepairPrompt({
              id,
              kind,
              action,
              language: appLanguageRef.current.resolved,
              terminalAgent: config.terminalAgent,
            });
            await ptyWrite({ data });
          },
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
          listPacks: listPacksForHealth,
          diagnosePack: async (id, kind) => {
            const { createPackDiagnoseHandler } = await import(
              "./runtime/yorishiro-mcp/tool-handlers"
            );
            const deps = buildPackToolDeps();
            return createPackDiagnoseHandler({
              ...deps,
              readUserPackEntries: readUserPackEntriesForPackTools,
            })({ id, kind });
          },
          disablePack: async (id) => {
            const { createDisablePackHandler } = await import(
              "./runtime/yorishiro-mcp/tool-handlers"
            );
            const deps = buildPackToolDeps();
            return createDisablePackHandler({
              updateConfig: deps.updateConfig,
              registry: packRegistry,
              disableBundledAmenity: disableBundledAmenityForPackTools,
            })({ id });
          },
          enablePack: async (id) => {
            const { createEnablePackHandler } = await import(
              "./runtime/yorishiro-mcp/tool-handlers"
            );
            const deps = buildPackToolDeps();
            return createEnablePackHandler({
              updateConfig: deps.updateConfig,
              reloadPack: reloadPackForPackTools,
              enableBundledAmenity: enableBundledAmenityForPackTools,
            })({ id });
          },
          getHealthReport: collectAppHealthReport,
          setPrimaryPersona: async (id) => {
            await updateConfig({ primaryPersona: id });
            personaRegistry.setPrimaryPersona(
              resolvePrimaryPersonaForLanguage(id, appLanguageRef.current.resolved),
            );
          },
          setActiveScene: async (id) => {
            await setActiveSceneFromUserSelection(id);
          },
          setTerminalAgent: async (agent) => {
            await updateConfig({ terminalAgent: agent });
            // terminalAgent は既存セッションに反映しない仕様（仕様書通り）
          },
          setAmbientAudioMuted: async (muted) => {
            await updateConfig({ ambientAudioMuted: muted });
            ambientAudio.setMuted(muted);
          },
          setActiveAmbientUi: async (ids) => {
            await updateActiveAmbientUi(ids);
          },
          setAmbientAudioVolume: async (volume) => {
            const clamped = clampAmbientAudioVolume(volume);
            await updateConfig({ ambientAudioVolume: clamped });
            ambientAudio.setVolume(clamped);
          },
          setAttentionLightNotifications: async (enabled) => {
            await updateConfig({ attentionLightNotifications: enabled });
            getAttentionLightSettingsStore().setEnabled(enabled);
          },
          setMotionIntensity: async (value) => {
            const clamped = clampMotionIntensity(value);
            await updateConfig({ motionIntensity: clamped });
            getThreeRuntime().setMotionIntensity(clamped);
          },
          setLanguage: async (language) => {
            return enqueueConfigWrite(async () => {
              const cur = parseConfig(await readYorishiroConfigText());
              const resolved = resolveLanguage(language, getBrowserLocales());
              const nextPrimaryPersona = resolvePrimaryPersonaForLanguage(
                cur.primaryPersona,
                resolved,
              );
              const updated =
                cur.primaryPersona === nextPrimaryPersona
                  ? withLanguageSet(cur, language)
                  : withLanguageSet(withPrimaryPersonaSet(cur, null), language);
              await writeYorishiroConfigText(serializeConfig(updated));
              appLanguageRef.current = { configured: language, resolved };
              setAppLanguage({ configured: language, resolved });
              personaRegistry.setPrimaryPersona(
                resolvePrimaryPersonaForLanguage(updated.primaryPersona, resolved),
              );
            });
          },
          setVoiceFrequency: (voiceFrequency) => updateConfig({ voiceFrequency }),
          setTabMetadataBadges: async (enabled) => {
            await updateConfig({ tabMetadataBadges: enabled });
            setTabMetadataBadgesEnabled(enabled);
          },
          getPresenceLevel: () => getPresenceState().level,
          setPresenceLevel: async (level) => {
            const result = applyPresenceLevelFromApp(level, "settings");
            if ("unavailable" in result) throw new Error(result.reason);
          },
          getConfig: async () => {
            const text = await readYorishiroConfigText();
            const cur = parseConfig(text);
            const resolvedLanguage = resolveLanguage(cur.language, getBrowserLocales());
            return {
              primaryPersona: cur.primaryPersona,
              activeScene: resolveSceneForProject(
                cur,
                projectRootValue(currentProjectRootRef.current),
              ),
              terminalAgent: cur.terminalAgent,
              effectiveAgent: resolveEffectiveAgent(cur),
              agentPinnedByProfile: resolveDefaultAgentProfileId(cur),
              ambientAudioMuted: cur.ambientAudioMuted,
              ambientAudioVolume: cur.ambientAudioVolume,
              attentionLightNotifications: cur.attentionLightNotifications,
              motionIntensity: cur.motionIntensity,
              activeAmbientUi: cur.activeAmbientUi,
              language: cur.language,
              resolvedLanguage,
              voiceFrequency: cur.voiceFrequency,
              tabMetadataBadges: cur.tabMetadataBadges,
            };
          },
        },
        emitEvent: (name: string, payload?: unknown) => {
          runtime.bus.emitSynthetic({ type: "system", packId }, name, payload, 0);
        },
      };
    };

    const activateEntry = (entry: UiPackEntry | null) => {
      // 前の layout を捕捉してから cleanup（deactivate 時の閉じアニメ判定に使う）。
      const prevLayout = currentLayout;
      // 前の UI pack を cleanup
      if (currentAbort) currentAbort.abort();
      currentAbort = null;
      if (currentDisposable) currentDisposable.dispose();
      currentDisposable = null;
      if (currentContainer) {
        currentContainer.remove();
        currentContainer = null;
      }
      setCurrentLayout(null);
      if (resetLayoutForAllTerminals()) refitPresentedTerminals();
      claimState.releaseAll();
      setSceneLayerOverrides([]);

      if (!entry) {
        // トップバーのボタンで全画面 pack を閉じたか（closed presence＝ターミナルだけへ着地）。
        // 1-shot フラグはここで必ず消費する（pack 種別に関わらずリークさせない）。
        const exitToClosed = exitFullscreenToClosedRef.current;
        exitFullscreenToClosedRef.current = false;
        if (prevLayout?.transition?.kind === "stage") {
          // 前 pack が stage 遷移（theater 等）：reset 後の素の状態から「閉じアニメ」を再生する
          // （resetLayout で end-state を一旦 clear → playStage("close") が反対端へ override して tween）。
          playStage("close", exitToClosed);
        } else if (exitToClosed) {
          // 非 stage の全画面 pack（immersive 等）：閉じアニメは無いので即 closed presence へ。
          settlePresenceClosed();
        }
        return;
      }

      // presence "closed"（Sidebar 閉）のまま UI pack を出すと、shell-column が
      // presence-closed（display:none）+ render paused のままで見えない（F3 でキャラが出ない /
      // F4 が無反応）。UI pack はステージ/レイアウトを占有するので presence を resume する。
      // 明示起動なので settings-guard（restorePresenceFromPrompt）は通さず無条件に開ける。
      // theater / immersive は active UI pack としては presence target を宣言しない。
      // ここで開けたいのは host default shell なので、active-ui contract ではなく
      // host-default surface を即時復帰する（presence tween は stage tween と競合させない）。
      if (
        shouldResumeHostPresenceForUiActivation({
          entryId: entry.id,
          layout: entry.pack.layout,
          presenceLevel: getPresenceState().level,
          hostDefaultClosed: isHostDefaultPresenceClosed(),
          settingsPackId: SETTINGS_PACK_ID,
        })
      ) {
        applyPresenceLevelFromApp("default", "default", { immediate: true }, "host-default");
        syncPresenceLevelStyles("default");
      }

      const targets = applyLayoutForAllTerminals(entry.pack.layout);
      setCurrentLayout(entry.pack.layout);
      if (!targets) {
        devLog.write({
          subsystem: "UiPack",
          phase: "mount",
          note: `deferred mount of "${entry.id}" (DOM targets missing)`,
        });
        return;
      }
      refitPresentedTerminals();

      // stage 遷移を宣言した pack（theater 等）は、applyLayout が置いた end-state を
      // 反対端へ override して「開きアニメ」を再生する（snap でなく Tween）。
      if (entry.pack.layout.transition?.kind === "stage") playStage("open");

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

    // タブ切替・追加時に active UI pack のレイアウトを新ターミナルにも適用する。
    // React の DOM commit を待つため requestAnimationFrame で遅延させる。
    let prevActiveId = tabManager.getState().activeSessionId;
    let pendingRaf: number | null = null;
    const unsubTabs = tabManager.subscribe(() => {
      const nextActiveId = tabManager.getState().activeSessionId;
      if (!currentLayout || nextActiveId === prevActiveId) {
        prevActiveId = nextActiveId;
        return;
      }
      prevActiveId = nextActiveId;
      if (pendingRaf !== null) cancelAnimationFrame(pendingRaf);
      pendingRaf = requestAnimationFrame(() => {
        pendingRaf = null;
        if (currentLayout) {
          applyLayoutForAllTerminals(currentLayout);
          refitPresentedTerminals();
        }
      });
    });

    return () => {
      if (pendingRaf !== null) cancelAnimationFrame(pendingRaf);
      unsubTabs();
      sub.dispose();
      if (currentAbort) currentAbort.abort();
      if (currentDisposable) currentDisposable.dispose();
      if (currentContainer) currentContainer.remove();
      setCurrentLayout(null);
      if (resetLayoutForAllTerminals()) refitPresentedTerminals();
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
    effectPackRunner,
    packRegistry,
    listPacksForHealth,
    collectAppHealthReport,
    readBundledPacks,
    applyPresenceLevelFromApp,
    createAmenityContext,
    ambientAudio,
    applyTerminalPresentationForSession,
    enqueueConfigWrite,
    updateYorishiroConfig,
    updateConfig,
    setActiveSceneFromUserSelection,
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
        body.setLipSyncSource(voicePlayer);
        dispatcher.setContextFactory(
          createRealPersonaContextFactory({
            body,
            logBridge,
            effectDispatcher,
            voicePlayer,
            personaRegistry,
          }),
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
        bodyRef.current?.setLipSyncSource(null);
        dispatcher.setContextFactory(createStubPersonaContextFactory());
      }
    },
    [dispatcher, logBridge, effectDispatcher, voicePlayer, personaRegistry],
  );

  // ── Workspace attention → Aura / Body minimal presence wiring ─────

  useEffect(() => {
    const store = getWorkspaceAttentionStore();
    const attention = getAttentionRuntime();
    const disposable = startWorkspaceAttentionPresenceBridge({
      store,
      attention,
      getBody: () => bodyRef.current,
    });
    return () => {
      disposable.dispose();
    };
  }, []);

  // 全 session の許可待ち（SessionStatusStore）を workspace-attention item に橋渡しする。
  useEffect(() => {
    const disposable = startSessionAttentionProducer({
      store: getWorkspaceAttentionStore(),
      sessionStatus: sessionStatusStore,
    });
    return () => {
      disposable.dispose();
    };
  }, [sessionStatusStore]);

  // workspace-attention の awaiting-approval item を attention light の cue に橋渡しする。
  useEffect(() => {
    const disposable = startAttentionLightCueBridge({
      cueStore: getAttentionLightCueStore(),
      attentionStore: getWorkspaceAttentionStore(),
    });
    return () => {
      disposable.dispose();
    };
  }, []);

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
          // agent tool 実行を AgentToolRun primitive として観察に記録（IW-P2 surfacing）。
          getAgentToolRunStore().ingestActivity(event.activity, event.timestamp);
        }
        if (event.kind === "loop-lifecycle") {
          // 自律 loop の lifecycle を LoopRun として観察に記録（IW-P2 surfacing）。
          getLoopRunStore().ingestPhase(event.phase, event.agent, event.timestamp);
        }
        if (event.kind === "hook-signal" && event.signal.name === "user-prompt-submit") {
          inTurnRef.current = true;
          bodyRef.current?.setState("thinking");
          // 生理反射：注意の切り替え（瞬き + 視線を作業対象へ）
          bodyRef.current?.notifyAttentionShift();
        }
        if (event.kind === "hook-signal" && event.signal.name === "pre-tool-use") {
          bodyRef.current?.setState("thinking");
        }
        if (event.kind === "hook-signal" && event.signal.name === "post-tool-failure") {
          // 生理反射：startle（速い瞬き + 頭の微小な引き + 息止め）。
          // persona の演技（distressed 等）とは独立の生理層で、cooldown は Body 側。
          if (shouldTriggerStartleForToolFailure(event.signal.payload)) {
            bodyRef.current?.notifyStartle();
          }
        }
        if (event.kind === "hook-signal" && event.signal.name === "stop") {
          inTurnRef.current = false;
          bodyRef.current?.setState("idle");
          // 生理反射：ターンの区切りで一息つく
          bodyRef.current?.notifySettle();
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

  const handledHookSignalSeqsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let polling = true;
    let unlistenHookSignal: (() => void) | null = null;
    const appLog = createSubsystemLog(devLog, "App");
    appLog.write({ phase: "polling", note: "starting hook-signal polling" });

    const handleSignal = (sig: string): void => {
      const seq = hookSignalSeq(sig);
      if (seq !== null) {
        const handled = handledHookSignalSeqsRef.current;
        if (handled.has(seq)) return;
        handled.add(seq);
        // immediate/polling の短い重複 window だけを潰せればよいので小さな
        // FIFO set にする。current seq は残す。
        if (handled.size > 512) {
          const oldest = handled.values().next().value;
          if (typeof oldest === "number") handled.delete(oldest);
        }
      }
      perception.onHookSignal(sig);
      const fallbackSessionId = tabManager.getState().mainSessionId;
      const targetSessionId = parseHookTargetSessionId(sig) ?? fallbackSessionId;
      const notification = parseHookAttentionSignal(sig);
      if (notification) {
        sessionStatusStore.markAttentionRequest(
          notification.sessionId ?? targetSessionId,
          notification,
        );
      } else if (isAttentionResolvingSignal(sig)) {
        sessionStatusStore.clearNonLoopAttention(targetSessionId);
      }
    };

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenHookSignal = await listen<string>("hook-signal", (event) => {
        handleSignal(event.payload);
      });
    })();

    const poll = async () => {
      appLog.write({ phase: "polling", note: "loop started" });
      while (polling) {
        try {
          const signals = await invoke<string[]>("poll_hook_signals");
          if (signals.length > 0) {
            appLog.write({ phase: "polling", note: "polled signals", data: signals });
          }
          for (const sig of signals) {
            handleSignal(sig);
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
      unlistenHookSignal?.();
    };
  }, [perception, devLog, sessionStatusStore, tabManager]);

  // NOTE: perception.dispose() is NOT called in useEffect cleanup.
  // StrictMode runs cleanup even for [] deps, which would dispose the
  // shared Perception instance. The idle timer is harmless to leave running.

  // ── Folder picker ─────────────────────────────────────────────

  const handlePickFolder = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const selected = await open({
        directory: true,
        title: strings.selectProjectFolder,
      });
      if (selected) {
        const nextCwd = selected as string;
        if (nextCwd === cwd) return;
        localStorage.setItem(CWD_STORAGE_KEY, nextCwd);
        // Workspace 切替は runtime singleton 群を一度作り直す。
        // PTY / xterm / perception の寿命が絡むため、差分更新より WebView reload の方が安定する。
        beginCurtainReload();
      }
    } catch {
      // Dialog not available outside Tauri
    }
  }, [cwd, beginCurtainReload, strings.selectProjectFolder]);

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

  // Convert filesystem path to Tauri asset URL.
  // vrmPath が未設定なら組み込みモデルをデフォルトとして使う。
  useEffect(() => {
    if (!vrmPath) {
      setVrmUrl("/models/CLAI.vrm");
      return;
    }
    setVrmUrl(convertFileSrc(vrmPath));
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
    let regionContextTimer: number | null = null;
    disposables.push(
      terminal.subscribeRegionContext((context) => {
        const source = "terminal:user-selection";
        if (regionContextTimer !== null) window.clearTimeout(regionContextTimer);
        attention.setSourceTarget(source, {
          kind: "terminal-region",
          source,
          rect: context.rect,
          confidence: 0.9,
          priority: 7,
          timestamp: performance.now(),
          reason: "user-pointed",
        });
        regionContextTimer = window.setTimeout(() => {
          regionContextTimer = null;
          attention.setSourceTarget(source, null);
        }, 3000);
      }),
    );

    const subscribeHookSignal = (handler: (event: { name: string }) => void): Disposable => {
      const trigger = {
        id: "builtin:hook-signal-to-tool-attention",
        match: (event: import("@yorishiro/sdk").DispatchEvent) => {
          if (event.kind === "hook-signal") {
            return { reaction: "__noop__" as import("@yorishiro/sdk").ReactionType };
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
        match: (event: import("@yorishiro/sdk").DispatchEvent) => {
          if (event.kind === "tool-activity") {
            return { reaction: "__noop__" as import("@yorishiro/sdk").ReactionType };
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
      if (regionContextTimer !== null) {
        window.clearTimeout(regionContextTimer);
        attention.setSourceTarget("terminal:user-selection", null);
      }
      for (const d of disposables) d.dispose();
    };
  }, [tabState.activeSessionId, runtime.bus.register]);

  // command-run attention producer は tab session 全体に張る。
  // 表示は active tab だけでも、背景 session の command metadata は workspace-attention
  // に残し、表示できない locus は session locus に畳む。
  useEffect(() => {
    const workspaceAttention = getWorkspaceAttentionStore();
    const disposables: Disposable[] = [];
    for (const sessionId of tabState.sessions) {
      const terminal = getTerminalRuntime(sessionId);
      disposables.push(startCommandRunAttentionProducer({ store: workspaceAttention, terminal }));
    }
    return () => {
      for (const d of disposables) d.dispose();
    };
  }, [tabState.sessions]);

  // mcp attention producer を起動する。
  // @tauri-apps/api/event の listen を ListenFactory に adapt して inject する。
  // dynamic import は非同期のため、他 producer の起動を妨げないよう独立した useEffect に分離。
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
      // それ以外 → "shell" surface（.shell-column = 全カラム）。
      // 両方なければ null を返す。
      const getTargetRect = (tool: string) => {
        const activeUi = document.querySelector<HTMLElement>(
          ".ui-pack-container:not(.ui-pack-container--ambient)",
        );
        const presence = resolvePresenceSurface();
        const sidebar = presence.ok ? presence.el : null;
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

  const folderName = useMemo(
    () => (cwd ? cwd.split("/").pop() || cwd : strings.defaultFolderName),
    [cwd, strings.defaultFolderName],
  );

  const sessionTabLabels = useMemo(() => {
    const labels = new Map<string, string>();
    for (const sessionId of tabState.sessions) {
      if (sessionId === tabState.mainSessionId) {
        labels.set(sessionId, formatMainSessionTabLabel(primaryPersonaState?.name));
        continue;
      }
      const sessionCwd = tabManager.getSessionCwd(sessionId);
      labels.set(
        sessionId,
        formatShellSessionTabLabel(sessionCwd === undefined ? cwd : sessionCwd),
      );
    }
    return labels;
  }, [cwd, primaryPersonaState?.name, tabManager, tabState.mainSessionId, tabState.sessions]);

  // ── Settings: close-requested listener ─────────────────────

  useEffect(() => {
    const onCloseRequested = (event: Event) => {
      const detail = (event as CustomEvent<{ target: string | null }>).detail;
      const uiPackRegistry = getUiRegistry();
      const availableIds = uiPackRegistry.listEntries().map((e) => e.id);
      const target = resolveCloseTarget({ saved: detail?.target ?? null, availableIds });
      uiPackRegistry.setActiveUi(target);
    };
    window.addEventListener("yorishiro-settings:close-requested", onCloseRequested);
    return () => {
      window.removeEventListener("yorishiro-settings:close-requested", onCloseRequested);
    };
  }, []);

  // ── Session tab keybindings ────────────────────────────────
  useEffect(() => {
    if (!isUserLayerReady) return;
    return installTabKeybindings(tabManager, { getNewSessionCwd: () => cwd });
  }, [cwd, isUserLayerReady, tabManager]);

  // ── PTY exit → auto-respawn / tab close ────────────────────
  const ptyExitCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!isUserLayerReady) return;
    let disposed = false;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ session_id: string; code: number }>("pty-exit", (event) => {
        if (disposed) return;
        if (event.payload.session_id !== tabManager.getState().mainSessionId) {
          sessionStatusStore.recordExit(event.payload.session_id, event.payload.code);
        }
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
  }, [isUserLayerReady, sessionStatusStore, tabManager]);

  useEffect(() => {
    if (!isUserLayerReady) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen<{ session_id: string; cwd: string }>(
        "pty-cwd-changed",
        (event) => {
          if (disposed) return;
          tabManager.updateSessionCwd(event.payload.session_id, event.payload.cwd);
        },
      );
      if (disposed) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isUserLayerReady, tabManager]);

  // Rust 側の app_screenshot は撮影完了後に "yorishiro:screen-flash" を emit する。
  // ここで listen して screen-flash effect を dispatch することで、
  // OS-level screenshot 撮影直後の視覚フィードバックを提供する。
  useEffect(() => {
    if (!isUserLayerReady) return;
    let disposed = false;
    let cleanup: (() => void) | null = null;

    void (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const unlisten = await listen("yorishiro:screen-flash", () => {
        if (disposed) return;
        effectDispatcher.dispatch({ kind: "screen-flash" });
      });
      if (disposed) {
        unlisten();
      } else {
        cleanup = unlisten;
      }
    })();

    return () => {
      disposed = true;
      cleanup?.();
    };
  }, [isUserLayerReady, effectDispatcher]);

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

  // command run の keyboard 操作（active session）。
  // Cmd+Shift+F: 直近 failed run を reference 化。
  // Cmd+] / Cmd+[: 次 / 前の command block へ jump（block navigation）。
  // Cmd+Shift+]: 次の failed block へ jump。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      if (event.code === "KeyF" && event.shiftKey) {
        event.preventDefault();
        getTerminalRuntime(tabState.activeSessionId).attachLastFailedRun();
      } else if (event.code === "BracketRight") {
        event.preventDefault();
        getTerminalRuntime(tabState.activeSessionId).scrollToAdjacentCommandRun("next", {
          failedOnly: event.shiftKey,
        });
      } else if (event.code === "BracketLeft") {
        event.preventDefault();
        getTerminalRuntime(tabState.activeSessionId).scrollToAdjacentCommandRun("previous");
      }
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [tabState.activeSessionId]);

  // screen-shake は bundled-packs/effects/screen-shake を EffectPackRunner
  // 経由で動かす（runtime singleton で register 済み）。この useEffect は不要。

  return (
    <div className="app">
      <TitleBar
        sidebarOpen={sidebarOpen}
        settingsActive={settingsActive}
        sidebarLabel={strings.labelPresence}
        settingsLabel={strings.settings}
        onToggleSidebar={handleToggleSidebar}
        onOpenSettings={handleOpenSettings}
        tabs={
          <TabIndicator
            state={tabState}
            labels={sessionTabLabels}
            statuses={sessionStatusById}
            hookBadges={sessionHookBadges}
            onSelectSession={(sessionId) => tabManager.switchTo(sessionId)}
            onAddSession={() => tabManager.openShell(cwd)}
            onCloseSession={(sessionId) => tabManager.close(sessionId)}
          />
        }
      />
      {runtimeLevaStore ? (
        <LevaPanel
          store={runtimeLevaStore}
          hidden={levaHidden}
          collapsed={false}
          flat
          titleBar={{
            title: "Common",
            drag: true,
            filter: true,
            position: { x: 0, y: 0 },
          }}
        />
      ) : null}
      {activeSceneLevaStore ? (
        <LevaPanel
          key={activeSceneLevaStore.storeId}
          store={activeSceneLevaStore}
          hidden={levaHidden}
          collapsed={false}
          flat
          titleBar={{ title: "Scene", drag: true, filter: true, position: { x: -300, y: 0 } }}
        />
      ) : null}
      <div className="app-body">
        <div
          className="shell-column"
          // .shell-column は App と同寿命で条件 unmount しない。register は置換
          // semantics、ref が null で呼ばれても if(el) で no-op なので unregister 不要。
          ref={(el) => {
            if (el) getSurfaceRegistry().register("shell", el);
          }}
        >
          <Sidebar folderName={folderName} onPickFolder={handlePickFolder} />
          <CharacterSurface
            vrmUrl={vrmUrl}
            onBodyReady={handleBodyReady}
            bodyDevLog={bodyDevLog}
            scene={renderedSceneEntry}
          />
        </div>
        {canMountTerminals && (
          <TerminalWorkspace
            sessions={tabState.sessions}
            activeSessionId={tabState.activeSessionId}
            cwd={cwd}
            getSessionCwd={getSessionCwd}
            getSpec={getTerminalSpec}
            getInterruptProtectionMode={getInterruptProtectionMode}
            perception={perception}
            shouldAttachExistingSession={shouldAttachExistingSession}
            onActivate={handleTerminalActivate}
          />
        )}
      </div>
      {firstRunHealth && (
        <FirstRunHealthPanel
          report={firstRunHealth}
          onOpenSettings={handleOpenSettings}
          onDismiss={dismissFirstRunHealth}
        />
      )}
      {restoreDialog ? (
        <RestoreConfirmDialog
          seq={restoreDialog.seq}
          changeText={restoreDialog.changeText}
          timeText={restoreDialog.timeText}
          surface="themed"
          strings={restoreConfirmStrings(strings)}
          onClose={handleRestoreDialogClose}
          onConfirm={handleRestoreDialogConfirm}
        />
      ) : null}
      {reloadCurtainPhase !== "hidden" ? (
        <div className="reload-curtain" data-phase={reloadCurtainPhase} aria-hidden="true" />
      ) : null}
    </div>
  );
}

export default App;
