import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";

/** undefined waits for the host; null retains the existing terminal route. */
export type ContinuityExecutionPreference = "pi" | null | undefined;

export function useContinuityExecutionPreference(): ContinuityExecutionPreference {
  const [preference, setPreference] = useState<ContinuityExecutionPreference>(undefined);
  useEffect(() => {
    let disposed = false;
    let request = 0;
    const refresh = async () => {
      const current = ++request;
      let next: "pi" | null;
      try {
        const result = await invoke<unknown>("continuity_execution_backend");
        if (result !== "pi" && result !== null) throw new Error("Invalid execution preference");
        next = result;
      } catch (error) {
        // An older running host has no Pi routing command. Other failures must
        // not silently launch CLI work when the configured Pi route is unknown.
        const message = String(error);
        const olderHost =
          message.includes("continuity_execution_backend") &&
          /(?:command.*not found|unknown command)/i.test(message);
        next = olderHost ? null : "pi";
      }
      if (!disposed && current === request) setPreference(next);
    };
    void refresh();
    window.addEventListener("focus", refresh);
    window.addEventListener("yorishiro:pi-configured", refresh);
    return () => {
      disposed = true;
      window.removeEventListener("focus", refresh);
      window.removeEventListener("yorishiro:pi-configured", refresh);
    };
  }, []);
  return preference;
}

export function continuityExecutionRoute(
  preference: ContinuityExecutionPreference,
  terminalAgent: string,
  mainSessionId: string | null,
  legacyStartupReady: boolean,
): { backend: "codex" | "text" | "pi"; sessionId: string | null } | null {
  if (preference === undefined) return null;
  if (preference === "pi") return { backend: "pi", sessionId: null };
  if (terminalAgent !== "codex") return { backend: "text", sessionId: null };
  // Startup can resolve the user layer before session restore and the prompt.
  // Keep that temporary absence from activating work with no Main Agent.
  if (!legacyStartupReady) return null;
  return { backend: "codex", sessionId: mainSessionId };
}
