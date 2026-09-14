import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { ScreenCaptureRegion, ScreenSourceKind } from "../bindings/tauri-commands";
import { getMediaPermissionKind, type MediaPermissionKind } from "./media-permissions";
import { MAX_SHARING_INTERVAL_SECONDS, MIN_SHARING_INTERVAL_SECONDS } from "./sharing-interval";

export const AUXILIARY_CONTROLS_LABEL = "auxiliary-screen-sharing-controls";
export const AUXILIARY_STATE_EVENT = "auxiliary-window-state";
export const AUXILIARY_ACTION_EVENT = "auxiliary-window-action";

/** Both the native label and bundled route must match; an auxiliary view never mounts App. */
export function resolveWindowView(label: string, search: string) {
  if (label === "main") return "main";
  if (
    label === "auxiliary-screen-preview" &&
    new URLSearchParams(search).get("auxiliary") === "screen-preview"
  )
    return "screen-preview";
  if (
    label === "auxiliary-camera-preview" &&
    new URLSearchParams(search).get("auxiliary") === "camera-preview"
  )
    return "camera-preview";
  if (
    label === AUXILIARY_CONTROLS_LABEL &&
    new URLSearchParams(search).get("auxiliary") === "screen-sharing-controls"
  ) {
    return "screen-sharing-controls";
  }
  return null;
}

export interface ScreenSharingSnapshot {
  readonly uiColors?: Record<string, string>;
  readonly permissionKind?: MediaPermissionKind;
  readonly previewVisible?: boolean;
  readonly revision: string;
  /** Changes with the main owner or marker setting, never with capture progress. */
  readonly pointerRevision: string;
  readonly available: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly pointersEnabled: boolean;
  readonly pointersReady: boolean;
  readonly sources: readonly { readonly id: number; readonly name: string }[];
  readonly sourceKind?: "screen" | "camera";
  readonly screenSourceKind?: ScreenSourceKind;
  readonly region?: ScreenCaptureRegion | null;
  readonly sourceId: number | null;
  readonly intervalSeconds: number;
  readonly contactSheetFrameCount?: number;
  readonly hasError: boolean;
  readonly lastObservedAt: number | null;
  readonly language: "en" | "ja";
}

export interface PublishedAuxiliarySnapshot {
  readonly version: number;
  readonly snapshot: ScreenSharingSnapshot;
}

export type ScreenSharingAuxiliaryAction =
  | { readonly type: "set-preview-visible"; readonly visible: boolean }
  | { readonly type: "start" | "stop" | "refresh-sources" | "clear-annotations" | "retry-pointers" }
  | { readonly type: "select-source-kind"; readonly sourceKind: "screen" | "camera" }
  | { readonly type: "select-screen-source-kind"; readonly screenSourceKind: ScreenSourceKind }
  | { readonly type: "select-region" }
  | { readonly type: "select-source"; readonly sourceId: number }
  | { readonly type: "set-pointers-enabled"; readonly enabled: boolean }
  | { readonly type: "set-interval"; readonly intervalSeconds: number }
  | { readonly type: "set-contact-sheet-frame-count"; readonly contactSheetFrameCount: number };

export interface RoutedAuxiliaryAction {
  readonly revision: string;
  readonly pointerRevision: string;
  readonly action: ScreenSharingAuxiliaryAction;
}

export function isPointerSettingsAction(action: ScreenSharingAuxiliaryAction): boolean {
  return action.type === "set-pointers-enabled" || action.type === "retry-pointers";
}

export interface ScreenSharingAuxiliaryModel {
  readonly uiColors?: Record<string, string>;
  readonly previewVisible?: boolean;
  readonly setPreviewVisible?: (visible: boolean) => void;
  readonly ownerKey: string;
  readonly available: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly pointersEnabled: boolean;
  readonly pointersReady: boolean;
  readonly sources: readonly { readonly id: number; readonly name: string }[];
  readonly sourceKind?: "screen" | "camera";
  readonly screenSourceKind?: ScreenSourceKind;
  readonly region?: ScreenCaptureRegion | null;
  readonly sourceId: number | null;
  readonly intervalSeconds: number;
  readonly contactSheetFrameCount?: number;
  readonly error?: string;
  readonly lastObservedAt?: number;
  readonly language: string;
  readonly start: () => Promise<void>;
  readonly stop: () => void;
  readonly refreshSources: () => Promise<void>;
  readonly clearAnnotations: () => Promise<void>;
  readonly retryPointers: () => Promise<void>;
  readonly setPointersEnabled: (enabled: boolean) => Promise<void>;
  readonly setSourceKind?: (kind: "screen" | "camera") => void;
  readonly setScreenSourceKind?: (kind: ScreenSourceKind) => void;
  readonly selectRegion?: () => Promise<void>;
  readonly setSourceId: (id: number) => void;
  readonly setIntervalSeconds: (seconds: number) => void;
  readonly setContactSheetFrameCount?: (count: number) => void;
}

/** Copy known public fields only. In particular, errors may contain provider details. */
export function createScreenSharingSnapshot(
  model: ScreenSharingAuxiliaryModel,
  revision: string,
  pointerRevision = revision,
): ScreenSharingSnapshot {
  return {
    revision,
    uiColors: model.uiColors,
    pointerRevision,
    available: model.available,
    active: model.active,
    busy: model.busy,
    pointersEnabled: model.pointersEnabled,
    pointersReady: model.pointersReady,
    permissionKind: getMediaPermissionKind(model.error),
    previewVisible: model.previewVisible ?? true,
    sources: model.sources.slice(0, 64).map(({ id, name }) => ({ id, name: name.slice(0, 200) })),
    sourceKind: model.sourceKind ?? "screen",
    screenSourceKind: model.screenSourceKind ?? "display",
    region: model.region ?? null,
    sourceId: model.sourceId,
    intervalSeconds: model.intervalSeconds,
    contactSheetFrameCount: model.contactSheetFrameCount ?? 16,
    hasError: Boolean(model.error),
    lastObservedAt: model.lastObservedAt ?? null,
    language: model.language.startsWith("ja") ? "ja" : "en",
  };
}

interface HostTransport {
  listenAction: (callback: (request: RoutedAuxiliaryAction) => void) => Promise<() => void>;
  publish: (snapshot: ScreenSharingSnapshot) => Promise<void>;
  open: () => Promise<void>;
  revision: () => string;
}

/** A hot-reloaded UI can run against an older native snapshot schema. */
export function createAuxiliarySnapshotPublisher(
  publish: (snapshot: ScreenSharingSnapshot) => Promise<void>,
): (snapshot: ScreenSharingSnapshot) => Promise<void> {
  let legacySchema = false;
  const unsupported = new Set<string>();
  const legacySnapshot = (snapshot: ScreenSharingSnapshot): ScreenSharingSnapshot => {
    const { screenSourceKind, region: _region, ...legacy } = snapshot;
    // A legacy auxiliary view must never offer a restricted selection as a display.
    return snapshot.sourceKind !== "camera" && screenSourceKind && screenSourceKind !== "display"
      ? { ...legacy, available: false, sources: [], sourceId: null }
      : legacy;
  };
  return async (snapshot) => {
    for (;;) {
      const compatible = { ...(legacySchema ? legacySnapshot(snapshot) : snapshot) };
      if (unsupported.has("contactSheetFrameCount")) delete compatible.contactSheetFrameCount;
      if (unsupported.has("uiColors")) delete compatible.uiColors;
      try {
        await publish(compatible);
        return;
      } catch (error) {
        const field =
          /unknown field [`'"](region|screenSourceKind|contactSheetFrameCount|uiColors)[`'"]/.exec(
            String(error),
          )?.[1];
        if (!field || unsupported.has(field)) throw error;
        unsupported.add(field);
        if (field === "region" || field === "screenSourceKind") legacySchema = true;
      }
    }
  };
}

const nativeHostTransport: HostTransport = {
  listenAction: (callback) =>
    getCurrentWindow().listen<RoutedAuxiliaryAction>(AUXILIARY_ACTION_EVENT, (event) =>
      callback(event.payload),
    ),
  publish: createAuxiliarySnapshotPublisher((snapshot) =>
    invoke("auxiliary_window_publish", { snapshot }),
  ),
  open: () => invoke("auxiliary_window_open", { kind: "screen-sharing-controls" }),
  revision: () => crypto.randomUUID(),
};

/** One main-window owner: no capture, session, or image delivery is performed by this bridge. */
export class ScreenSharingAuxiliaryHost {
  private model: ScreenSharingAuxiliaryModel | null = null;
  private snapshot: ScreenSharingSnapshot | null = null;
  private signature = "";
  private pointerSignature = "";
  private disposed = false;
  private unlisten: (() => void) | null = null;
  private publishQueue: Promise<void> = Promise.resolve();
  private publishError: unknown = null;
  private listening: Promise<void> | null = null;

  constructor(
    private readonly onError: (error: unknown) => void,
    private readonly transport: HostTransport = nativeHostTransport,
  ) {
    void this.ensureListening().catch((error: unknown) => {
      if (!this.disposed) onError(error);
    });
  }

  private ensureListening(): Promise<void> {
    if (this.disposed || this.unlisten) return Promise.resolve();
    if (this.listening) return this.listening;
    const attempt = this.transport
      .listenAction((request) => {
        void this.handleAction(request).catch(this.onError);
      })
      .then((unlisten) => {
        if (this.disposed) unlisten();
        else this.unlisten = unlisten;
      });
    this.listening = attempt;
    // Only an explicit open retries a failed registration; concurrent opens share the attempt.
    void attempt.catch(() => {
      if (this.listening === attempt) this.listening = null;
    });
    return attempt;
  }

  update(model: ScreenSharingAuxiliaryModel): void {
    if (this.disposed) return;
    this.model = model;
    const safeFields = createScreenSharingSnapshot(model, "");
    // The owner affects revisions without revealing an agent or thread identifier to other views.
    const signature = JSON.stringify([model.ownerKey, safeFields]);
    if (signature === this.signature) return;
    this.signature = signature;
    const revision = this.transport.revision();
    const pointerSignature = JSON.stringify([
      model.ownerKey,
      model.pointersEnabled,
      model.pointersReady,
    ]);
    const pointerRevision =
      pointerSignature === this.pointerSignature && this.snapshot
        ? this.snapshot.pointerRevision
        : revision;
    this.pointerSignature = pointerSignature;
    const snapshot = { ...safeFields, revision, pointerRevision };
    this.snapshot = snapshot;
    this.enqueuePublish(snapshot);
  }

  private enqueuePublish(snapshot: ScreenSharingSnapshot): void {
    this.publishQueue = this.publishQueue
      .then(async () => {
        if (this.disposed) return;
        await this.transport.publish(snapshot);
        this.publishError = null;
      })
      .catch((error: unknown) => {
        if (this.disposed) return;
        this.publishError = error;
        this.onError(error);
      });
  }

  private async waitForPublications(): Promise<void> {
    let pending: Promise<void>;
    do {
      pending = this.publishQueue;
      await pending;
    } while (!this.disposed && pending !== this.publishQueue);
  }

  async open(): Promise<void> {
    await this.ensureListening();
    await this.waitForPublications();
    if (this.disposed || !this.snapshot) return;
    if (this.publishError) {
      // A failed publication must be retryable even when unchanged state was deduplicated.
      this.enqueuePublish(this.snapshot);
      await this.waitForPublications();
    }
    if (this.disposed) return;
    if (this.publishError) throw this.publishError;
    await this.transport.open();
  }

  /** Check again in the owner: a newer React state may precede its native publication. */
  async handleAction(request: RoutedAuxiliaryAction): Promise<boolean> {
    const model = this.model;
    const snapshot = this.snapshot;
    if (this.disposed || !model || !snapshot) return false;
    const { action } = request;
    if (
      isPointerSettingsAction(action)
        ? request.pointerRevision !== snapshot.pointerRevision
        : request.revision !== snapshot.revision
    )
      return false;
    switch (action.type) {
      case "set-preview-visible":
        if (!model.setPreviewVisible || typeof action.visible !== "boolean") return false;
        model.setPreviewVisible(action.visible);
        break;
      case "start":
        if (
          !model.available ||
          (model.sourceKind !== "camera" &&
            (model.screenSourceKind ?? "display") === "display" &&
            !model.pointersReady) ||
          model.active ||
          model.busy ||
          ((model.sourceKind === "camera" || model.screenSourceKind !== "region") &&
            !model.sources.some((source) => source.id === model.sourceId))
        )
          return false;
        await model.start();
        break;
      case "stop":
        model.stop();
        break;
      case "refresh-sources":
        if (model.active || model.busy) return false;
        await model.refreshSources();
        break;
      case "clear-annotations":
        if (model.sourceKind === "camera" || (model.screenSourceKind ?? "display") !== "display")
          return false;
        await model.clearAnnotations();
        break;
      case "retry-pointers":
        if (model.sourceKind === "camera" || (model.screenSourceKind ?? "display") !== "display")
          return false;
        if (model.pointersReady || !model.error) return false;
        await model.retryPointers();
        break;
      case "set-pointers-enabled":
        if (model.sourceKind === "camera" || (model.screenSourceKind ?? "display") !== "display")
          return false;
        if (!model.pointersReady || typeof action.enabled !== "boolean") return false;
        await model.setPointersEnabled(action.enabled);
        break;
      case "select-source-kind":
        if (
          model.active ||
          model.busy ||
          !model.setSourceKind ||
          (action.sourceKind !== "screen" && action.sourceKind !== "camera")
        )
          return false;
        model.stop();
        model.setSourceKind(action.sourceKind);
        break;
      case "select-screen-source-kind":
        if (
          model.active ||
          model.busy ||
          !model.setScreenSourceKind ||
          model.sourceKind === "camera" ||
          !["display", "window", "region"].includes(action.screenSourceKind)
        )
          return false;
        model.setScreenSourceKind(action.screenSourceKind);
        break;
      case "select-region":
        if (
          model.active ||
          !model.selectRegion ||
          model.sourceKind === "camera" ||
          model.screenSourceKind !== "region" ||
          model.busy
        )
          return false;
        await model.selectRegion();
        break;
      case "select-source":
        if (
          model.active ||
          model.busy ||
          !model.sources.some((source) => source.id === action.sourceId)
        )
          return false;
        model.setSourceId(action.sourceId);
        break;
      case "set-interval":
        if (
          !Number.isInteger(action.intervalSeconds) ||
          action.intervalSeconds < MIN_SHARING_INTERVAL_SECONDS ||
          action.intervalSeconds > MAX_SHARING_INTERVAL_SECONDS
        )
          return false;
        model.setIntervalSeconds(action.intervalSeconds);
        break;
      case "set-contact-sheet-frame-count":
        if (
          !model.setContactSheetFrameCount ||
          ![4, 9, 16, 25].includes(action.contactSheetFrameCount)
        )
          return false;
        model.setContactSheetFrameCount(action.contactSheetFrameCount);
        break;
    }
    return true;
  }

  dispose(): void {
    this.disposed = true;
    this.model = null;
    this.snapshot = null;
    this.unlisten?.();
    this.unlisten = null;
  }
}

export function readAuxiliarySnapshot(): Promise<PublishedAuxiliarySnapshot | null> {
  return invoke("auxiliary_window_snapshot");
}

export function requestAuxiliaryAction(
  version: number,
  action: ScreenSharingAuxiliaryAction,
  pointerRevision?: string,
): Promise<void> {
  return invoke("auxiliary_window_request_action", {
    request: { version, action, ...(pointerRevision === undefined ? {} : { pointerRevision }) },
  });
}

export function listenAuxiliarySnapshot(
  callback: (snapshot: PublishedAuxiliarySnapshot) => void,
): Promise<() => void> {
  return getCurrentWindow().listen<PublishedAuxiliarySnapshot>(AUXILIARY_STATE_EVENT, (event) =>
    callback(event.payload),
  );
}

/** A late initial read must not replace an event that already delivered newer state. */
export function latestAuxiliarySnapshot(
  current: PublishedAuxiliarySnapshot | null,
  incoming: PublishedAuxiliarySnapshot,
): PublishedAuxiliarySnapshot {
  return current && current.version > incoming.version ? current : incoming;
}
