import type { Trigger } from "@charminal/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import persona from "../bundled-packs/personas/charminal-default/persona";
import type { Body } from "./core/body";
import { LogBridge } from "./core/log-bridge";
import { Perception } from "./core/perception";
import { Time } from "./core/time";
import { EventBus, type EventBusLogger } from "./runtime/event-bus";
import {
  createRealPersonaContextFactory,
  createStubPersonaContextFactory,
  PersonaRegistry,
} from "./runtime/persona-registry";
import Sidebar from "./sidebar";
import Terminal from "./terminal";
import "./App.css";

const CWD_STORAGE_KEY = "charminal:cwd";
const VRM_STORAGE_KEY = "charminal:vrm";

/**
 * Built-in triggers that map DispatchEvents to standard reactions.
 * The flagship persona has no custom triggers; these provide the
 * minimal wiring for Phase 3.5.
 */
const builtInTriggers: ReadonlyArray<Trigger> = [
  {
    id: "builtin:idle-to-fidget",
    match: (event) => (event.kind === "idle" ? { reaction: "idle-fidget" } : null),
  },
  {
    id: "builtin:stop-to-pleased",
    match: (event) =>
      event.kind === "hook-signal" && event.signal.name === "stop" ? { reaction: "pleased" } : null,
  },
  {
    id: "builtin:prompt-to-acknowledging",
    match: (event) =>
      event.kind === "hook-signal" && event.signal.name === "user-prompt-submit"
        ? { reaction: "acknowledging" }
        : null,
  },
  {
    id: "builtin:tool-to-contemplative",
    match: (event) =>
      event.kind === "hook-signal" && event.signal.name === "pre-tool-use"
        ? { reaction: "contemplative" }
        : null,
  },
];

function App() {
  const [cwd, setCwd] = useState<string | null>(() => localStorage.getItem(CWD_STORAGE_KEY));
  const [vrmPath, setVrmPath] = useState<string | null>(() =>
    localStorage.getItem(VRM_STORAGE_KEY),
  );

  // ── Runtime stack (stable across re-renders) ────────────────

  const runtimeRef = useRef<{
    time: Time;
    bus: EventBus;
    registry: PersonaRegistry;
    perception: Perception;
    logBridge: LogBridge;
  } | null>(null);

  if (runtimeRef.current === null) {
    const time = new Time();
    const logger: EventBusLogger = {
      warn: (msg, meta) => console.warn(`[charminal] ${msg}`, meta),
      error: (msg, meta) => console.error(`[charminal] ${msg}`, meta),
    };
    const bus = new EventBus({ time, logger });
    const logBridge = new LogBridge({ time });
    const registry = new PersonaRegistry({ bus, time, logger });
    const perception = new Perception({ bus, time });

    // Register flagship persona with built-in triggers
    const augmented = {
      ...persona,
      reflex: {
        ...persona.reflex,
        customTriggers: builtInTriggers,
      },
    };
    registry.register(augmented);

    runtimeRef.current = { time, bus, registry, perception, logBridge };
  }

  const { perception, registry, logBridge } = runtimeRef.current;

  // ── Body ↔ PersonaRegistry wiring ──────────────────────────

  const handleBodyReady = useCallback(
    (body: Body | null) => {
      if (body) {
        registry.setContextFactory(createRealPersonaContextFactory({ body, logBridge }));
      } else {
        registry.setContextFactory(createStubPersonaContextFactory());
      }
    },
    [registry, logBridge],
  );

  // ── Hook-signal listener (global, independent of PTY lifecycle) ──

  useEffect(() => {
    let polling = true;
    console.log("[App] starting hook-signal polling..."); // DEBUG: polling lifecycle

    const poll = async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      console.log("[App] polling loop started"); // DEBUG: polling lifecycle
      while (polling) {
        try {
          const signals = await invoke<string[]>("poll_hook_signals");
          if (signals.length > 0) {
            console.log("[App] polled signals:", signals); // DEBUG: hook delivery
          }
          for (const sig of signals) {
            perception.onHookSignal(sig);
          }
        } catch (err) {
          console.warn("[App] poll_hook_signals failed:", err); // DEBUG: polling error
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    };
    poll().catch((err) => {
      console.error("[App] polling setup failed:", err); // DEBUG: polling error
    });

    return () => {
      polling = false;
    };
  }, [perception]);

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

  return (
    <div className="app">
      <Sidebar
        folderName={folderName}
        onPickFolder={handlePickFolder}
        vrmUrl={vrmUrl}
        onLoadVrm={handleLoadVrm}
        onBodyReady={handleBodyReady}
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
