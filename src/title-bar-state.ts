import { useEffect, useState } from "react";
import { getPresenceState, type PresenceLevel } from "./runtime/presence-intensity";
import type { UiPackEntry } from "./runtime/ui-pack-registry";
import { getUiRegistry } from "./runtime/ui-pack-registry";

export function sidebarOpenFromPresenceLevel(level: PresenceLevel): boolean {
  return level === "default";
}

export function resolvePickerActiveViewModeId(
  settingsActive: boolean,
  savedViewMode: unknown,
  activeUiId: string | null,
): string | null {
  if (!settingsActive) return activeUiId;
  return typeof savedViewMode === "string" ? savedViewMode : null;
}

export interface ViewModeShortcut {
  readonly id: string | null;
  readonly code: string;
  readonly hint: string;
}

/**
 * View Mode shortcuts use Option+Command on macOS and Control+Alt elsewhere,
 * keeping the numbered sequence separate from the terminal tab shortcuts.
 * The first nine registered modes receive a stable slot; additional user modes
 * remain fully accessible through the picker until configurable bindings exist.
 */
export function buildViewModeShortcuts(
  entries: ReadonlyArray<Pick<UiPackEntry, "id">>,
  macos: boolean,
): ReadonlyArray<ViewModeShortcut> {
  const prefix = macos ? "⌥⌘" : "Ctrl+Alt+";
  return [
    { id: null, code: "Digit0", hint: `${prefix}0` },
    ...entries.slice(0, 9).map((entry, index) => ({
      id: entry.id,
      code: `Digit${index + 1}`,
      hint: `${prefix}${index + 1}`,
    })),
  ];
}

export function matchesViewModeShortcut(
  shortcut: ViewModeShortcut,
  event: Pick<KeyboardEvent, "altKey" | "code" | "ctrlKey" | "metaKey" | "shiftKey">,
  macos: boolean,
): boolean {
  return (
    event.code === shortcut.code &&
    !event.shiftKey &&
    event.altKey &&
    event.ctrlKey === !macos &&
    event.metaKey === macos
  );
}

export function nativeWindowControlsVisibleForViewMode(activeViewModeId: string | null): boolean {
  return activeViewModeId === null;
}

export function roundedWindowForViewMode(activeViewModeId: string | null): boolean {
  return activeViewModeId === "companion" || activeViewModeId === "portrait";
}

export function activePresentationViewModeId(
  settingsActive: boolean,
  pickerActiveViewModeId: string | null,
): string | null {
  return settingsActive ? null : pickerActiveViewModeId;
}

export function shouldShowProjectSelector(
  userLayerReady: boolean,
  activeUiId: string | null,
): boolean {
  return userLayerReady && activeUiId === null;
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
    window.addEventListener("yorishiro:presence-level-changed", onPresenceChanged);
    return () => {
      window.removeEventListener("yorishiro:presence-level-changed", onPresenceChanged);
    };
  }, []);

  return sidebarOpen;
}

export function useActiveUiId(): string | null {
  const [activeUiId, setActiveUiId] = useState(() => getUiRegistry().getActiveUi()?.id ?? null);

  useEffect(() => {
    const sub = getUiRegistry().subscribeActive((entry) => {
      setActiveUiId(entry?.id ?? null);
    });
    return () => sub.dispose();
  }, []);

  return activeUiId;
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

export function useViewModes(): ReadonlyArray<UiPackEntry> {
  const [entries, setEntries] = useState<ReadonlyArray<UiPackEntry>>(() =>
    getUiRegistry().listEntries(),
  );
  useEffect(() => {
    const sub = getUiRegistry().subscribeEntries(setEntries);
    return () => sub.dispose();
  }, []);
  const platform = /Mac/i.test(navigator.platform)
    ? "macos"
    : /Win/i.test(navigator.platform)
      ? "windows"
      : "linux";
  return sortViewModeEntries(
    entries.filter((entry) => {
      const metadata = entry.manifest.viewMode;
      return (
        metadata?.enabled === true && (!metadata.platforms || metadata.platforms.includes(platform))
      );
    }),
  );
}

const BUILT_IN_VIEW_MODE_ORDER = new Map([
  ["companion", 0],
  ["portrait", 1],
  ["theater", 2],
  ["immersive", 3],
]);

export function sortViewModeEntries(
  entries: ReadonlyArray<UiPackEntry>,
): ReadonlyArray<UiPackEntry> {
  return [...entries].sort((a, b) => {
    const builtInA = BUILT_IN_VIEW_MODE_ORDER.get(a.id);
    const builtInB = BUILT_IN_VIEW_MODE_ORDER.get(b.id);
    if (builtInA !== undefined || builtInB !== undefined) {
      if (builtInA === undefined) return 1;
      if (builtInB === undefined) return -1;
      return builtInA - builtInB;
    }
    const metadataOrder =
      (a.manifest.viewMode?.order ?? Number.MAX_SAFE_INTEGER) -
      (b.manifest.viewMode?.order ?? Number.MAX_SAFE_INTEGER);
    return metadataOrder || a.id.localeCompare(b.id);
  });
}
