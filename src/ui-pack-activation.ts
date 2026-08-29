import type { UiLayout } from "@yorishiro/sdk";
import type { PresenceLevel } from "./runtime/presence-intensity";
import type { Disposable } from "./sdk/context";

export interface HostPresenceResumeInput {
  readonly entryId: string;
  readonly layout: UiLayout;
  readonly presenceLevel: PresenceLevel;
  readonly hostDefaultClosed: boolean;
  readonly settingsPackId: string;
}

export function layoutNeedsHostPresenceResume(layout: UiLayout): boolean {
  return layout.sidebar?.width === "fullscreen";
}

export function shouldResumeHostPresenceForUiActivation({
  entryId,
  layout,
  presenceLevel,
  hostDefaultClosed,
  settingsPackId,
}: HostPresenceResumeInput): boolean {
  if (entryId === settingsPackId) return false;
  return layoutNeedsHostPresenceResume(layout) || presenceLevel === "closed" || hostDefaultClosed;
}

export function subscribeAndActivateCurrentUi<Entry>(
  registry: {
    getActiveUi(): Entry | null;
    subscribeActive(listener: (entry: Entry | null) => void): Disposable;
  },
  activate: (entry: Entry | null) => void,
): Disposable {
  const subscription = registry.subscribeActive(activate);
  activate(registry.getActiveUi());
  return subscription;
}

export function isUiPackHostReady(
  userLayerReady: boolean,
  sessionRestoreReady: boolean,
  systemPromptResolved: boolean,
): boolean {
  return userLayerReady && sessionRestoreReady && systemPromptResolved;
}

export function resolvePersistedUiId(id: string | null): string | null {
  return id === "overlay" ? null : id;
}

export function shouldAnimateTheaterTransition(
  previousId: string | null,
  nextId: string | null,
): boolean {
  return (
    (previousId === null && nextId === "theater") || (previousId === "theater" && nextId === null)
  );
}
