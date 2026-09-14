import { Camera, LoaderCircle, MonitorUp, Undo2, X } from "lucide-react";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { ScreenCaptureRegion, ScreenSourceKind } from "./bindings/tauri-commands";
import { CameraPreviewToggle } from "./camera-preview-toggle";
import { MediaPermissionHelp } from "./media-permission-help";
import { CONTACT_SHEET_FRAME_COUNTS } from "./runtime/codex-realtime/use-screen-sharing";
import { getMediaPermissionKind } from "./runtime/media-permissions";
import {
  formatSharingInterval,
  MAX_SHARING_INTERVAL_SECONDS,
  MIN_SHARING_INTERVAL_SECONDS,
} from "./runtime/sharing-interval";
import { ScreenPointerToggle } from "./screen-pointer-toggle";
import { ScreenSourceOptions } from "./screen-source-options";
import { SharingSourceMenu } from "./sharing-source-menu";
import { SharingStatus } from "./sharing-status";
import "./screen-sharing-control.css";

export interface ScreenSharingControlProps {
  readonly screenSourceKind?: ScreenSourceKind;
  readonly screenSelectionSupported?: boolean;
  readonly region?: ScreenCaptureRegion | null;
  readonly onScreenSourceKindChange?: (kind: ScreenSourceKind) => void;
  readonly previewVisible?: boolean;
  readonly onPreviewVisibleChange?: (visible: boolean) => void;
  readonly sourceKind?: "screen" | "camera";
  readonly onSourceKindChange?: (kind: "screen" | "camera") => void;
  readonly activeViewModeId: string | null;
  readonly available: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly pointersEnabled: boolean;
  readonly pointersReady: boolean;
  readonly intervalSeconds: number;
  readonly contactSheetFrameCount?: number;
  readonly sources: readonly { readonly id: number; readonly name: string }[];
  readonly sourceId: number | null;
  readonly error?: string;
  readonly lastObservedAt?: number;
  readonly onIntervalChange: (value: number) => void;
  readonly onContactSheetFrameCountChange?: (value: number) => void;
  readonly onSourceChange: (id: number) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onRetryPointers: () => void;
  readonly onPointersEnabledChange: (enabled: boolean) => void;
  readonly onRefreshSources: () => void;
  readonly onOpenAuxiliary?: () => Promise<void>;
  readonly language?: string;
}

const strings = {
  en: {
    title: "Screen sharing",
    activeTitle: "Screen sharing on",
    close: "Close sharing settings",
    retryAuxiliary: "Retry opening screen sharing",
    auxiliaryUnavailable: "The screen sharing window is not ready. Try again.",
    display: "Display",
    chooseDisplay: "Choose a display",
    noDisplays: "No displays available",
    refresh: "Refresh displays",
    interval: "Send interval",
    frameCount: "Frames per send",
    hint: "Shorter intervals use more tokens.",
    seconds: (value: number) => formatSharingInterval(value, "en"),
    unavailable: "Select an agent that supports screen sharing to start.",
    cancel: "Cancel",
    selecting: "Selecting region…",
    start: "Start sharing",
    stop: "Stop sharing",
  },
  ja: {
    title: "画面共有",
    activeTitle: "画面共有中",
    close: "共有の設定を閉じる",
    retryAuxiliary: "画面共有ウィンドウを再試行",
    auxiliaryUnavailable: "画面共有ウィンドウの準備ができていません。もう一度お試しください。",
    display: "画面選択",
    chooseDisplay: "画面を選択",
    noDisplays: "共有できる画面がありません",
    refresh: "画面一覧を更新",
    interval: "送信間隔",
    frameCount: "送信コマ数",
    hint: "間隔が短いほどトークン消費が増えます。",
    seconds: (value: number) => formatSharingInterval(value, "ja"),
    unavailable: "画面共有に対応するエージェントを選択してください。",
    cancel: "キャンセル",
    selecting: "範囲を選択中…",
    start: "共有を開始",
    stop: "共有を停止",
  },
} as const;

const PANEL_WIDTH = 310;
const PANEL_MARGIN = 12;
type PanelMode = "closed" | "measuring" | "inline" | "auxiliary-error";

function panelPosition(trigger: HTMLButtonElement | null, compactError = false) {
  const width = Math.min(PANEL_WIDTH, Math.max(0, window.innerWidth - PANEL_MARGIN * 2));
  const rect = trigger?.getBoundingClientRect();
  const top = compactError
    ? 40
    : Math.min((rect?.bottom ?? 32) + 8, Math.max(PANEL_MARGIN, window.innerHeight - 100));
  return {
    left: Math.max(
      PANEL_MARGIN,
      Math.min(rect?.left ?? PANEL_MARGIN, window.innerWidth - width - PANEL_MARGIN),
    ),
    top,
    width,
    maxHeight: Math.max(0, window.innerHeight - top - PANEL_MARGIN),
  };
}

/** Controlled screen-sharing settings. Opening the panel never starts capture. */
export function ScreenSharingControl({
  previewVisible = true,
  onPreviewVisibleChange,
  sourceKind = "screen",
  screenSourceKind = "display",
  screenSelectionSupported = true,
  region,
  onScreenSourceKindChange,
  onSourceKindChange,
  activeViewModeId,
  available,
  active,
  busy,
  pointersEnabled,
  pointersReady,
  intervalSeconds,
  contactSheetFrameCount = 16,
  sources,
  sourceId,
  error,
  lastObservedAt,
  onIntervalChange,
  onContactSheetFrameCountChange,
  onSourceChange,
  onStart,
  onStop,
  onPointersEnabledChange,
  onRetryPointers,
  onRefreshSources,
  onOpenAuxiliary,
  language = "en",
}: ScreenSharingControlProps) {
  const permissionKind = getMediaPermissionKind(error);
  const [choosingSource, setChoosingSource] = useState(true);
  const [panelMode, setPanelMode] = useState<PanelMode>("closed");
  const [openingAuxiliary, setOpeningAuxiliary] = useState(false);
  const [auxiliaryError, setAuxiliaryError] = useState<string>();
  const [panelStyle, setPanelStyle] = useState<ReturnType<typeof panelPosition>>();
  const openingAuxiliaryRef = useRef<{ dismissed: boolean } | null>(null);
  const measurementRef = useRef<ReturnType<typeof panelPosition> | null>(null);
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();
  const displayId = useId();
  const intervalId = useId();
  const frameCountId = useId();
  const isJapanese = language.startsWith("ja");
  const baseLabels = strings[isJapanese ? "ja" : "en"];
  const camera = sourceKind === "camera";
  const chooser = Boolean(onSourceKindChange) && choosingSource && !active && !busy;
  const labels = camera
    ? {
        ...baseLabels,
        title: isJapanese ? "カメラ共有" : "Camera sharing",
        activeTitle: isJapanese ? "カメラ共有中" : "Camera sharing on",
        display: isJapanese ? "カメラ選択" : "Camera",
        chooseDisplay: isJapanese ? "カメラを選択" : "Choose a camera",
        noDisplays: isJapanese ? "共有できるカメラがありません" : "No cameras available",
        refresh: isJapanese ? "カメラ一覧を更新" : "Refresh cameras",
      }
    : screenSourceKind === "window"
      ? {
          ...baseLabels,
          display: isJapanese ? "ウィンドウ選択" : "Window",
          chooseDisplay: isJapanese ? "ウィンドウを選択" : "Choose a window",
          noDisplays: isJapanese ? "共有できるウィンドウがありません" : "No windows available",
          refresh: isJapanese ? "ウィンドウ一覧を更新" : "Refresh windows",
        }
      : baseLabels;
  const sharingTitle = onSourceKindChange ? (isJapanese ? "共有" : "Sharing") : labels.title;
  const displayError = auxiliaryError ?? error;
  const open = panelMode === "inline" || panelMode === "auxiliary-error";
  const measuring = panelMode === "measuring";
  const hasSelectedSource = sources.some((source) => source.id === sourceId);
  const canStart =
    available &&
    (camera || screenSourceKind !== "display" || pointersReady) &&
    (screenSourceKind === "region" && !camera ? screenSelectionSupported : hasSelectedSource) &&
    !busy;

  const closePanel = useCallback(() => {
    measurementRef.current = null;
    if (openingAuxiliaryRef.current) openingAuxiliaryRef.current.dismissed = true;
    setPanelMode("closed");
  }, []);

  const openAuxiliary = useCallback(async () => {
    if (openingAuxiliaryRef.current) return;
    const request = { dismissed: false };
    openingAuxiliaryRef.current = request;
    setOpeningAuxiliary(true);
    try {
      if (!onOpenAuxiliary) throw new Error(labels.auxiliaryUnavailable);
      await onOpenAuxiliary();
      if (openingAuxiliaryRef.current === request && !request.dismissed) {
        setPanelMode("closed");
        setAuxiliaryError(undefined);
      }
    } catch (failure) {
      if (openingAuxiliaryRef.current === request && !request.dismissed) {
        setAuxiliaryError(failure instanceof Error ? failure.message : String(failure));
        setPanelStyle(panelPosition(triggerRef.current, true));
        setPanelMode("auxiliary-error");
      }
    } finally {
      if (openingAuxiliaryRef.current === request) {
        openingAuxiliaryRef.current = null;
        setOpeningAuxiliary(false);
      }
    }
  }, [labels.auxiliaryUnavailable, onOpenAuxiliary]);

  const openPanel = () => {
    if (openingAuxiliaryRef.current || measurementRef.current) return;
    setAuxiliaryError(undefined);
    setChoosingSource(true);
    if (!active) onRefreshSources();
    // Pack IDs differ from their display labels: portrait is Call, companion is Portrait.
    if (activeViewModeId === "portrait" || activeViewModeId === "companion") {
      void openAuxiliary();
      return;
    }
    const position = panelPosition(triggerRef.current);
    measurementRef.current = position;
    setPanelStyle(position);
    setPanelMode("measuring");
  };

  useLayoutEffect(() => {
    const position = measurementRef.current;
    if (!measuring || !position) return;
    measurementRef.current = null;
    const height = panelRef.current?.getBoundingClientRect().height ?? 0;
    if (position.width >= PANEL_WIDTH && height > 0 && height <= position.maxHeight) {
      setPanelMode("inline");
    } else {
      setPanelMode("closed");
      void openAuxiliary();
    }
  }, [measuring, openAuxiliary]);

  useEffect(
    () => () => {
      measurementRef.current = null;
      openingAuxiliaryRef.current = null;
    },
    [],
  );

  useEffect(() => {
    if (!open) return;
    // Resize may reposition an open panel, but only another click chooses its destination.
    const positionPanel = () =>
      setPanelStyle(panelPosition(triggerRef.current, panelMode === "auxiliary-error"));
    window.addEventListener("resize", positionPanel);
    closeRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        closePanel();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePanel();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [closePanel, open, panelMode]);

  const sourceControls = (
    <div className="screen-sharing-source-row">
      <select
        id={displayId}
        aria-label={labels.display}
        value={hasSelectedSource ? (sourceId ?? "") : ""}
        disabled={active || busy || !available}
        onPointerDown={() => {
          onRefreshSources();
        }}
        onKeyDown={(event) => {
          if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) {
            onRefreshSources();
          }
        }}
        onChange={(event) => {
          if (event.currentTarget.value !== "") {
            onSourceChange(Number(event.currentTarget.value));
          }
        }}
      >
        <option value="" disabled>
          {sources.length > 0 ? labels.chooseDisplay : labels.noDisplays}
        </option>
        {sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <fieldset
      className="screen-sharing-control"
      aria-label={labels.title}
      ref={rootRef}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          closePanel();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`title-bar-button screen-sharing-trigger${active || open ? " is-active" : ""}`}
        data-sharing-active={active}
        aria-label={active ? labels.activeTitle : sharingTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-busy={openingAuxiliary}
        aria-controls={open ? panelId : undefined}
        title={displayError ?? (active ? labels.activeTitle : sharingTitle)}
        onClick={() =>
          panelMode === "auxiliary-error" ? void openAuxiliary() : open ? closePanel() : openPanel()
        }
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) openPanel();
          }
        }}
      >
        {openingAuxiliary ? (
          <LoaderCircle size={15} className="screen-sharing-spinner" aria-hidden="true" />
        ) : active && camera ? (
          <Camera size={15} aria-hidden="true" />
        ) : (
          <MonitorUp size={15} strokeWidth={1.8} aria-hidden="true" />
        )}
        {active ? <span className="screen-sharing-dot" aria-hidden="true" /> : null}
      </button>
      {panelMode === "auxiliary-error" ? (
        <div
          id={panelId}
          className="screen-sharing-panel screen-sharing-open-error"
          style={panelStyle}
          role="dialog"
          aria-labelledby={titleId}
        >
          <div className="screen-sharing-heading">
            <h2 id={titleId}>{chooser ? sharingTitle : labels.title}</h2>
            <button
              ref={closeRef}
              type="button"
              className="screen-sharing-icon-button"
              aria-label={labels.close}
              title={labels.close}
              onClick={() => {
                closePanel();
                triggerRef.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="screen-sharing-error" role="alert">
            {auxiliaryError}
          </p>
          <button
            type="button"
            className="screen-sharing-action"
            aria-busy={openingAuxiliary}
            disabled={openingAuxiliary}
            onClick={() => void openAuxiliary()}
          >
            {labels.retryAuxiliary}
          </button>
        </div>
      ) : panelMode === "inline" || measuring ? (
        <div
          ref={panelRef}
          id={panelId}
          className="screen-sharing-panel"
          style={
            measuring
              ? { ...panelStyle, maxHeight: undefined, visibility: "hidden", pointerEvents: "none" }
              : panelStyle
          }
          role="dialog"
          aria-labelledby={titleId}
          aria-hidden={measuring || undefined}
          inert={measuring || undefined}
        >
          <div className="screen-sharing-heading">
            {!chooser && onSourceKindChange && !active && !busy ? (
              <button
                type="button"
                className="sharing-back"
                aria-label={isJapanese ? "戻る" : "Back"}
                title={isJapanese ? "戻る" : "Back"}
                onClick={() => {
                  const panel = panelRef.current;
                  setChoosingSource(true);
                  requestAnimationFrame(() =>
                    panel
                      ?.querySelector<HTMLButtonElement>(
                        ".sharing-source-menu button:not(:disabled)",
                      )
                      ?.focus(),
                  );
                }}
              >
                <Undo2 size={16} aria-hidden="true" />
              </button>
            ) : null}
            <h2 id={titleId}>{chooser ? sharingTitle : labels.title}</h2>
            <SharingStatus
              active={active}
              busy={busy}
              lastObservedAt={lastObservedAt}
              language={language}
            />
            <button
              ref={closeRef}
              type="button"
              className="screen-sharing-icon-button"
              aria-label={labels.close}
              title={labels.close}
              onClick={() => {
                closePanel();
                triggerRef.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          {chooser ? (
            <SharingSourceMenu
              language={language}
              onSelect={(kind) => {
                onSourceKindChange?.(kind);
                setChoosingSource(false);
              }}
            />
          ) : (
            <>
              {!camera && onScreenSourceKindChange ? (
                <ScreenSourceOptions
                  kind={screenSourceKind}
                  screenSelectionSupported={screenSelectionSupported}
                  region={region}
                  disabled={active || busy || !available}
                  language={language}
                  onKindChange={onScreenSourceKindChange}
                >
                  {screenSourceKind === "region" ? null : sourceControls}
                </ScreenSourceOptions>
              ) : (
                sourceControls
              )}

              <div className="screen-sharing-interval-heading">
                <label className="screen-sharing-label" htmlFor={intervalId}>
                  {labels.interval}
                </label>
                <output htmlFor={intervalId}>{labels.seconds(intervalSeconds)}</output>
              </div>
              <input
                id={intervalId}
                className="screen-sharing-slider"
                type="range"
                min={MIN_SHARING_INTERVAL_SECONDS}
                max={MAX_SHARING_INTERVAL_SECONDS}
                step={1}
                value={intervalSeconds}
                aria-valuetext={labels.seconds(intervalSeconds)}
                onChange={(event) => onIntervalChange(Number(event.currentTarget.value))}
              />
              <p className="screen-sharing-description screen-sharing-interval-hint">
                {labels.hint}
              </p>
              {onContactSheetFrameCountChange ? (
                <>
                  <div className="screen-sharing-interval-heading">
                    <label className="screen-sharing-label" htmlFor={frameCountId}>
                      {labels.frameCount}
                    </label>
                    <output htmlFor={frameCountId}>{contactSheetFrameCount}</output>
                  </div>
                  <input
                    id={frameCountId}
                    className="screen-sharing-slider"
                    type="range"
                    min={0}
                    max={CONTACT_SHEET_FRAME_COUNTS.length - 1}
                    step={1}
                    value={CONTACT_SHEET_FRAME_COUNTS.indexOf(
                      contactSheetFrameCount as (typeof CONTACT_SHEET_FRAME_COUNTS)[number],
                    )}
                    aria-label={labels.frameCount}
                    aria-valuetext={String(contactSheetFrameCount)}
                    onChange={(event) =>
                      onContactSheetFrameCountChange(
                        CONTACT_SHEET_FRAME_COUNTS[Number(event.currentTarget.value)],
                      )
                    }
                  />
                </>
              ) : null}
              {onPreviewVisibleChange ? (
                <CameraPreviewToggle
                  visible={previewVisible}
                  language={language}
                  onChange={onPreviewVisibleChange}
                />
              ) : null}
              {!camera && screenSourceKind === "display" ? (
                <ScreenPointerToggle
                  enabled={pointersEnabled}
                  ready={pointersReady}
                  language={language}
                  onChange={onPointersEnabledChange}
                  onRetry={error ? onRetryPointers : undefined}
                />
              ) : null}

              {!available ? (
                <p className="screen-sharing-description">{labels.unavailable}</p>
              ) : null}
              {permissionKind ? (
                <MediaPermissionHelp kind={permissionKind} language={language} />
              ) : error ? (
                <p className="screen-sharing-error" role="alert">
                  {error}
                </p>
              ) : null}
              <button
                type="button"
                className="screen-sharing-action"
                data-active={active}
                disabled={
                  (!active && busy && !camera && screenSourceKind === "region") ||
                  (!active && !busy && !canStart)
                }
                onClick={active || busy ? onStop : onStart}
              >
                {active
                  ? labels.stop
                  : busy
                    ? !camera && screenSourceKind === "region"
                      ? labels.selecting
                      : labels.cancel
                    : labels.start}
              </button>
            </>
          )}
        </div>
      ) : null}
    </fieldset>
  );
}
