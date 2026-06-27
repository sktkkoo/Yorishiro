import { useEffect, useState } from "react";
import { getPresenceState, type PresenceLevel } from "./runtime/presence-intensity";
import { getUiRegistry } from "./runtime/ui-pack-registry";

export function sidebarOpenFromPresenceLevel(level: PresenceLevel): boolean {
  return level === "default";
}

function isPresenceLevel(value: unknown): value is PresenceLevel {
  return value === "default" || value === "closed";
}

export function useSidebarOpen(): boolean {
  const [sidebarOpen, setSidebarOpen] = useState(() =>
    sidebarOpenFromPresenceLevel(getPresenceState().level),
  );

  useEffect(() => {
    const onPresenceChanged = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (!isPresenceLevel(detail?.level)) return;
      setSidebarOpen(sidebarOpenFromPresenceLevel(detail.level));
    };
    window.addEventListener("charminal:presence-level-changed", onPresenceChanged);
    return () => {
      window.removeEventListener("charminal:presence-level-changed", onPresenceChanged);
    };
  }, []);

  return sidebarOpen;
}

export function useSettingsActive(settingsPackId: string): boolean {
  const [settingsActive, setSettingsActive] = useState(
    () => getUiRegistry().getActiveUi()?.id === settingsPackId,
  );

  useEffect(() => {
    const uiPackRegistry = getUiRegistry();
    const sub = uiPackRegistry.subscribeActive((entry) => {
      setSettingsActive(entry?.id === settingsPackId);
    });
    return () => sub.dispose();
  }, [settingsPackId]);

  return settingsActive;
}
