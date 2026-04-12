import type { Trigger } from "@charminal/sdk";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import persona from "../bundled-packs/personas/charminal-default/persona";
import { Perception } from "./core/perception";
import { Time } from "./core/time";
import { EventBus, type EventBusLogger } from "./runtime/event-bus";
import { PersonaRegistry } from "./runtime/persona-registry";
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
  } | null>(null);

  if (runtimeRef.current === null) {
    const time = new Time();
    const logger: EventBusLogger = {
      warn: (msg, meta) => console.warn(`[charminal] ${msg}`, meta),
      error: (msg, meta) => console.error(`[charminal] ${msg}`, meta),
    };
    const bus = new EventBus({ time, logger });
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

    runtimeRef.current = { time, bus, registry, perception };
  }

  const perception = runtimeRef.current.perception;

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      runtimeRef.current?.perception.dispose();
    };
  }, []);

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
      />
      <Terminal key={cwd ?? "__default__"} cwd={cwd} perception={perception} />
    </div>
  );
}

export default App;
