import type { Trigger } from "@charminal/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import screenShakePack from "../bundled-packs/effects/screen-shake/effect";
import persona from "../bundled-packs/personas/charminal-default/persona";
import quietRoomManifest from "../bundled-packs/scenes/quiet-room/manifest.json";
import quietRoomPack from "../bundled-packs/scenes/quiet-room/scene";
import type { Body, EyeState } from "./core/body";
import { createSubsystemLog, DevLog, type DevLogEntry } from "./core/dev-log";
import { LogBridge } from "./core/log-bridge";
import { Perception } from "./core/perception";
import type { SceneSpec } from "./core/scene";
import { EffectDispatcher, EffectPackRunner, Renderer } from "./core/space";
import { Time } from "./core/time";
import { EventBus, type EventBusLogger } from "./runtime/event-bus";
import { getOrInit } from "./runtime/hot-data";
import { getModuleRegistry } from "./runtime/module-registry";
import {
  createRealPersonaContextFactory,
  createStubPersonaContextFactory,
  PersonaRegistry,
} from "./runtime/persona-registry";
import {
  getSceneRegistry,
  resolveSceneAssets,
  type ScenePackRegistry,
} from "./runtime/scene-pack-registry";
import { loadUserLayer, UserPackRegistry } from "./runtime/user-pack-loader";
import { readCharminalConfigText } from "./runtime/user-pack-loader/charminal-io";
import { parseConfig } from "./runtime/user-pack-loader/config";
import type { ScenePackManifest } from "./sdk/scene-pack";
import Sidebar from "./sidebar";
import Terminal from "./terminal";
import "./App.css";

const CWD_STORAGE_KEY = "charminal:cwd";
const VRM_STORAGE_KEY = "charminal:vrm";

/**
 * Built-in triggers that map DispatchEvents to standard reactions.
 *
 * Currently empty — motion firing felt intrusive during ordinary
 * Claude Code turns. Handler definitions remain in persona.ts so
 * wiring can be restored by re-adding entries here:
 *
 *   - idle → idle-fidget
 *   - hook-signal "stop" → pleased
 *   - hook-signal "user-prompt-submit" → acknowledging
 *   - hook-signal "pre-tool-use" → contemplative
 */
const builtInTriggers: ReadonlyArray<Trigger> = [];

function App() {
  const [cwd, setCwd] = useState<string | null>(() => localStorage.getItem(CWD_STORAGE_KEY));
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
    const effectDispatcher = new EffectDispatcher();
    // Effect Pack infrastructure. screen-shake は body に transform を当てる
    // ことで fixed 子孫（three-runtime の canvas container）も含めて一緒に
    // 揺らす（body の transform は fixed 子孫の containing block を作る）。
    const renderer = new Renderer({ shakeTarget: document.body });
    const effectPackRunner = new EffectPackRunner({
      dispatcher: effectDispatcher,
      renderer,
      time,
    });
    effectPackRunner.register(screenShakePack);

    const registry = new PersonaRegistry({ bus, time, logger });
    const perception = new Perception({
      bus,
      time,
      devLog: createSubsystemLog(devLog, "Perception"),
    });

    // Scene pack registry — HMR singleton（KEYS.SCENE_PACK_REGISTRY で共有）。
    const scenePackRegistry: ScenePackRegistry = getSceneRegistry();

    // Merge built-in triggers with persona's own customTriggers. Previously
    // this replaced the persona array entirely, silently dropping the
    // persona's declared triggers.
    const augmented = {
      ...persona,
      reflex: {
        ...persona.reflex,
        customTriggers: [...builtInTriggers, ...(persona.reflex.customTriggers ?? [])],
      },
    };
    registry.register(augmented);

    // Bundled quiet-room scene pack を register し、config.activeScene を反映する。
    // fire-and-forget IIFE — try/catch で silent fail を防ぐ
    // （memory: feedback_dev_verification_not_enough.md）。
    const appLog = createSubsystemLog(devLog, "App");
    void (async () => {
      try {
        const resolved = await resolveSceneAssets(quietRoomPack.scene, {
          origin: "bundled",
          packId: quietRoomPack.id,
          onMissing: (layerId, src) => {
            appLog.write({
              phase: "register",
              note: `bundled scene "${quietRoomPack.id}": asset missing for layer "${layerId}" (src="${src}")`,
            });
          },
        });
        scenePackRegistry.register({
          id: quietRoomPack.id,
          manifest: quietRoomManifest as ScenePackManifest,
          scene: resolved,
          origin: "bundled",
        });
        appLog.write({
          phase: "register",
          note: `registered bundled scene '${quietRoomPack.id}'`,
        });

        // config.json から user の activeScene 選択を読み、Registry に反映。
        const configText = await readCharminalConfigText();
        const config = parseConfig(configText);
        scenePackRegistry.setActiveScene(config.activeScene);
      } catch (err) {
        appLog.write({
          phase: "register",
          note: "bundled scene register / config read failed",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      }
    })();

    // User layer (~/.charminal/packs/ + init.js) を bundled pack の後に load し、
    // hot-reload watcher を張る。singleton factory の中から fire-and-forget で
    // 起動する——runtime singleton は HMR をまたいで 1 回しか動かないので、
    // 多重 load にはならない。
    // 失敗しても Charminal 本体を落とさない（philosophy「壊さないこと」）。
    const packRegistry = new UserPackRegistry({
      log: createSubsystemLog(devLog, "UserPackRegistry"),
    });
    void loadUserLayer({
      effectPackRunner,
      personaRegistry: registry,
      scenePackRegistry,
      effectDispatcher,
      packRegistry,
      userPackLog: createSubsystemLog(devLog, "UserPackLoader"),
      initScriptLog: createSubsystemLog(devLog, "InitScript"),
    })
      .then(async ({ packs, init, safeMode }) => {
        appLog.write({
          phase: "user-layer",
          note: `user-layer ready (packs loaded=${packs.loaded.length} failed=${packs.failed.length}; init ran=${init.ran})`,
          data: { packs, init },
        });
        // Phase 1-c: safe mode のときだけ window title に suffix を付ける。
        // user が env var で safe mode に入ったことを常時 visible にする。
        // title 更新の失敗が後続の MCP listener 接続を道連れにしないよう
        // 独立した try-catch で包む（philosophy: docs/philosophy/CHARMINAL.md「壊さないこと」）。
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

        // Phase 1-c: MCP event channel wiring。Rust 側 MCP server が tool call を
        // 受けると `mcp:tool-request` event を emit、TS 側で対応 handler を走らせ
        // `mcp_tool_response` command で response を戻す。
        // Internal design-record: 2026-04-18-phase-1c-rescue-and-mcp.md Section 4.5
        try {
          const { listen } = await import("@tauri-apps/api/event");
          const { invoke } = await import("@tauri-apps/api/core");
          const { dispatchToolEvent } = await import("./runtime/charminal-mcp/event-channel");
          const { createListPacksHandler, createDisablePackHandler, createEnablePackHandler } =
            await import("./runtime/charminal-mcp/tool-handlers");
          const { readCharminalConfigText, writeCharminalConfigText, readLastStartupReport } =
            await import("./runtime/user-pack-loader/charminal-io");
          const { parseConfig, serializeConfig } = await import(
            "./runtime/user-pack-loader/config"
          );
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
          // Task 21: config.json から id を除外するだけでなく、file system から
          // 読み直して runtime registry に直接 register し直す経路。Task 16 の
          // 「file 存在確認だけ」limitation の fix。
          const userPackLog = createSubsystemLog(devLog, "UserPackLoader");
          const reloadPack = async (id: string): Promise<{ ok: boolean; reason?: string }> => {
            return reloadSingleUserPack(id, {
              effectPackRunner,
              personaRegistry: registry,
              scenePackRegistry,
              packRegistry,
              userPackLog,
            });
          };

          const handlers: ToolHandlerMap = {
            "list-packs": createListPacksHandler({
              readRegistry: () => packRegistry.listEntries(),
              readConfig,
              readLoadReport,
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
      })
      .catch((err: unknown) => {
        appLog.write({
          phase: "user-layer",
          note: "user-layer bootstrap crashed",
          data: { error: err instanceof Error ? err.message : String(err) },
        });
      });

    return {
      time,
      bus,
      registry,
      perception,
      logBridge,
      devLog,
      effectDispatcher,
      scenePackRegistry,
    };
  });

  const { perception, registry, logBridge, devLog, effectDispatcher, scenePackRegistry } = runtime;

  // active scene を Registry から subscribe して React state に流す。
  // `setActiveSceneState` と命名してメソッド名 `setActiveScene` との衝突を避ける。
  const [activeScene, setActiveSceneState] = useState<SceneSpec | null>(() =>
    scenePackRegistry.getActiveScene(),
  );
  useEffect(() => {
    const sub = scenePackRegistry.subscribeActive((scene) => setActiveSceneState(scene));
    return () => sub.dispose();
  }, [scenePackRegistry]);

  const bodyDevLog = useMemo(() => createSubsystemLog(devLog, "Body"), [devLog]);

  // ── Body ↔ PersonaRegistry wiring ──────────────────────────

  const bodyRef = useRef<Body | null>(null);
  const greetedRef = useRef(false);
  const inTurnRef = useRef(false);

  const handleBodyReady = useCallback(
    (body: Body | null) => {
      bodyRef.current = body;
      if (body) {
        registry.setContextFactory(
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
        registry.setContextFactory(createStubPersonaContextFactory());
      }
    },
    [registry, logBridge, effectDispatcher],
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
        setCwd(selected as string);
        localStorage.setItem(CWD_STORAGE_KEY, selected as string);
      }
    } catch {
      // Dialog not available outside Tauri
    }
  }, []);

  // ── VRM import ──────────────────────────────────────────────

  const handleLoadVrm = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const { invoke } = await import("@tauri-apps/api/core");
      const selected = await open({
        title: "VRM ファイルを選択",
        filters: [{ name: "VRM", extensions: ["vrm"] }],
      });
      if (selected) {
        const dest = await invoke<string>("import_vrm", { src: selected as string });
        setVrmPath(dest);
        localStorage.setItem(VRM_STORAGE_KEY, dest);
      }
    } catch {
      // Dialog not available outside Tauri
    }
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

  const folderName = useMemo(() => (cwd ? cwd.split("/").pop() || cwd : "デフォルト"), [cwd]);

  // screen-shake は bundled-packs/effects/screen-shake を EffectPackRunner
  // 経由で動かす（runtime singleton で register 済み）。この useEffect は不要。

  return (
    <div className="app">
      <Sidebar
        folderName={folderName}
        onPickFolder={handlePickFolder}
        vrmUrl={vrmUrl}
        onLoadVrm={handleLoadVrm}
        onBodyReady={handleBodyReady}
        bodyDevLog={bodyDevLog}
        effectDispatcher={effectDispatcher}
        scene={activeScene}
      />
      <Terminal
        key={cwd ?? "__default__"}
        cwd={cwd}
        systemPrompt={persona.thinking.systemPromptAddition}
        perception={perception}
      />
    </div>
  );
}

export default App;
