import type { UiLayout } from "@yorishiro/sdk";
import type { PresenceLevel } from "./runtime/presence-intensity";

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
