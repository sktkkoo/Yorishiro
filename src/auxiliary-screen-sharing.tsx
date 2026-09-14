import { Undo2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { CameraPreviewToggle } from "./camera-preview-toggle";
import { MediaPermissionHelp } from "./media-permission-help";
import {
  isPointerSettingsAction,
  latestAuxiliarySnapshot,
  listenAuxiliarySnapshot,
  type PublishedAuxiliarySnapshot,
  readAuxiliarySnapshot,
  requestAuxiliaryAction,
  type ScreenSharingAuxiliaryAction,
} from "./runtime/auxiliary-windows";
import { CONTACT_SHEET_FRAME_COUNTS } from "./runtime/contact-sheet-settings";
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
import "./auxiliary-screen-sharing.css";

const text = {
  en: {
    title: "Screen sharing",
    display: "Display",
    noDisplays: "No displays available",
    refresh: "Refresh displays",
    interval: "Send interval",
    frameCount: "Frames per send",
    hint: "Shorter intervals use more tokens.",
    seconds: (value: number) => formatSharingInterval(value, "en"),
    unavailable: "Choose an agent that supports screen sharing in the main window.",
    cancel: "Cancel",
    selecting: "Selecting region…",
    start: "Start sharing",
    stop: "Stop sharing",
    error: "Screen sharing failed. Check the main window for details.",
    pending: "Waiting for the main window…",
  },
  ja: {
    title: "画面共有",
    display: "画面選択",
    noDisplays: "共有できる画面がありません",
    refresh: "画面一覧を更新",
    interval: "送信間隔",
    frameCount: "送信コマ数",
    hint: "間隔が短いほどトークン消費が増えます。",
    seconds: (value: number) => formatSharingInterval(value, "ja"),
    unavailable: "メインウィンドウで画面共有に対応するエージェントを選択してください。",
    cancel: "キャンセル",
    selecting: "範囲を選択中…",
    start: "共有を開始",
    stop: "共有を停止",
    error: "画面共有でエラーが発生しました。詳細はメインウィンドウで確認してください。",
    pending: "メインウィンドウに接続しています…",
  },
} as const;

/** This view only renders published state and requests actions from the main-window owner. */
export default function AuxiliaryScreenSharing() {
  const [selectedSource, setSelectedSource] = useState<"screen" | "camera" | null>(null);
  const [published, setPublished] = useState<PublishedAuxiliarySnapshot | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [requesting, setRequesting] = useState(false);
  const [intervalDraft, setIntervalDraft] = useState(30);
  const [frameCountDraft, setFrameCountDraft] = useState(16);
  const [pointerDraft, setPointerDraft] = useState<{
    enabled: boolean;
    pointerRevision: string;
  } | null>(null);
  const pointerRequest = useRef(0);
  const latest = useRef(published);
  latest.current = published;
  const requestingRef = useRef(false);
  const state = published?.snapshot;
  const publishedInterval = state?.intervalSeconds;
  const publishedFrameCount = state?.contactSheetFrameCount;
  const uiColors = state?.uiColors;
  useEffect(() => {
    if (!uiColors) return;
    for (const [key, value] of Object.entries(uiColors)) {
      if (key.startsWith("--yorishiro-") && value)
        document.documentElement.style.setProperty(key, value);
    }
  }, [uiColors]);
  const language = state?.language ?? (navigator.language.startsWith("ja") ? "ja" : "en");
  const japanese = language === "ja";
  const camera = state?.sourceKind === "camera";
  const screenSourceKind = state?.screenSourceKind ?? "display";
  const chooser =
    state?.sourceKind !== undefined &&
    selectedSource !== state?.sourceKind &&
    !state?.active &&
    !state?.busy;
  const baseLabels = text[language];
  const labels = camera
    ? {
        ...baseLabels,
        title: japanese ? "カメラ共有" : "Camera sharing",
        display: japanese ? "カメラ選択" : "Camera",
        noDisplays: japanese ? "共有できるカメラがありません" : "No cameras available",
        refresh: japanese ? "カメラ一覧を更新" : "Refresh cameras",
      }
    : screenSourceKind === "window"
      ? {
          ...baseLabels,
          display: japanese ? "ウィンドウ選択" : "Window",
          noDisplays: japanese ? "共有できるウィンドウがありません" : "No windows available",
          refresh: japanese ? "ウィンドウ一覧を更新" : "Refresh windows",
        }
      : baseLabels;

  useEffect(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const receive = (next: PublishedAuxiliarySnapshot) => {
      if (!disposed) setPublished((current) => latestAuxiliarySnapshot(current, next));
    };
    void listenAuxiliarySnapshot(receive)
      .then(async (cleanup) => {
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        const initial = await readAuxiliarySnapshot();
        if (initial) receive(initial);
      })
      .catch((failure: unknown) => {
        if (!disposed) setActionError(String(failure));
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (publishedInterval !== undefined) setIntervalDraft(publishedInterval);
  }, [publishedInterval]);

  useEffect(() => {
    if (publishedFrameCount !== undefined) setFrameCountDraft(publishedFrameCount);
  }, [publishedFrameCount]);

  const request = async (action: ScreenSharingAuxiliaryAction) => {
    const current = latest.current;
    const independent = isPointerSettingsAction(action);
    const backgroundRefresh = action.type === "refresh-sources";
    if (!current || (!independent && requestingRef.current)) return;
    if (!independent && !backgroundRefresh) {
      requestingRef.current = true;
      setRequesting(true);
    }
    const pointerAttempt = independent ? ++pointerRequest.current : null;
    if (action.type === "set-pointers-enabled") {
      setPointerDraft({
        enabled: action.enabled,
        pointerRevision: current.snapshot.pointerRevision,
      });
    }
    setActionError(undefined);
    try {
      if (independent) {
        await requestAuxiliaryAction(current.version, action, current.snapshot.pointerRevision);
      } else {
        await requestAuxiliaryAction(current.version, action);
      }
    } catch (failure) {
      if (pointerAttempt !== null && pointerAttempt !== pointerRequest.current) return;
      if (pointerAttempt !== null) setPointerDraft(null);
      setActionError(String(failure));
      const refreshed = await readAuxiliarySnapshot().catch(() => null);
      if (refreshed) setPublished((previous) => latestAuxiliarySnapshot(previous, refreshed));
    } finally {
      if (!independent && !backgroundRefresh) {
        requestingRef.current = false;
        setRequesting(false);
      }
    }
  };

  if (!state) {
    return (
      <main className="screen-sharing-panel auxiliary-sharing">
        <header className="screen-sharing-heading">
          <h1>{chooser ? (japanese ? "共有" : "Sharing") : labels.title}</h1>
        </header>
        <p role="status">{labels.pending}</p>
        {actionError ? <p role="alert">{actionError}</p> : null}
      </main>
    );
  }

  const hasSelectedSource = state.sources.some((source) => source.id === state.sourceId);
  const canStart =
    state.available &&
    (camera || screenSourceKind !== "display" || state.pointersReady) &&
    ((!camera && screenSourceKind === "region") || hasSelectedSource) &&
    !state.busy &&
    !requesting;
  const commitInterval = (value: string) => {
    const intervalSeconds = Number(value);
    if (intervalSeconds !== state.intervalSeconds) {
      void request({ type: "set-interval", intervalSeconds });
    }
  };
  const commitFrameCount = (value: string) => {
    const frameCount = CONTACT_SHEET_FRAME_COUNTS[Number(value)];
    if (frameCount !== state.contactSheetFrameCount) {
      void request({ type: "set-contact-sheet-frame-count", contactSheetFrameCount: frameCount });
    }
  };

  const sourceControls = (
    <div className="screen-sharing-source-row">
      <select
        id="shared-display"
        aria-label={labels.display}
        value={hasSelectedSource ? (state.sourceId ?? "") : ""}
        disabled={state.active || state.busy || !state.available || requesting}
        onPointerDown={() => {
          void request({ type: "refresh-sources" });
        }}
        onKeyDown={(event) => {
          if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(event.key)) {
            void request({ type: "refresh-sources" });
          }
        }}
        onChange={(event) =>
          void request({ type: "select-source", sourceId: Number(event.currentTarget.value) })
        }
      >
        <option value="" disabled>
          {labels.noDisplays}
        </option>
        {state.sources.map((source) => (
          <option key={source.id} value={source.id}>
            {source.name}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <main className="screen-sharing-panel auxiliary-sharing">
      <header className="screen-sharing-heading">
        {!chooser && state.sourceKind !== undefined && !state.active && !state.busy ? (
          <button
            type="button"
            className="sharing-back"
            aria-label={japanese ? "戻る" : "Back"}
            title={japanese ? "戻る" : "Back"}
            onClick={(event) => {
              const panel = event.currentTarget.closest(".screen-sharing-panel");
              setSelectedSource(null);
              requestAnimationFrame(() =>
                panel
                  ?.querySelector<HTMLButtonElement>(".sharing-source-menu button:not(:disabled)")
                  ?.focus(),
              );
            }}
          >
            <Undo2 size={16} aria-hidden="true" />
          </button>
        ) : null}
        <h1>{chooser ? (japanese ? "共有" : "Sharing") : labels.title}</h1>
        <SharingStatus
          active={state.active}
          busy={state.busy}
          lastObservedAt={state.lastObservedAt ?? undefined}
          language={state.language}
        />
      </header>
      {chooser && (state.hasError || actionError) ? (
        <p className="screen-sharing-error" role="alert">
          {actionError ?? labels.error}
        </p>
      ) : null}
      {chooser ? (
        <SharingSourceMenu
          language={language}
          disabled={requesting}
          onSelect={(sourceKind) => {
            void request({ type: "select-source-kind", sourceKind });
            setSelectedSource(sourceKind);
          }}
        />
      ) : (
        <>
          {!camera && state.screenSourceKind !== undefined ? (
            <ScreenSourceOptions
              kind={screenSourceKind}
              region={state.region}
              disabled={state.active || state.busy || !state.available || requesting}
              language={language}
              onKindChange={(screenSourceKind) =>
                void request({ type: "select-screen-source-kind", screenSourceKind })
              }
            >
              {screenSourceKind === "region" ? null : sourceControls}
            </ScreenSourceOptions>
          ) : (
            sourceControls
          )}

          <div className="screen-sharing-interval-heading">
            <label className="screen-sharing-label" htmlFor="viewing-interval">
              {labels.interval}
            </label>
            <output htmlFor="viewing-interval">{labels.seconds(intervalDraft)}</output>
          </div>
          <input
            id="viewing-interval"
            className="screen-sharing-slider"
            type="range"
            min={MIN_SHARING_INTERVAL_SECONDS}
            max={MAX_SHARING_INTERVAL_SECONDS}
            step={1}
            value={intervalDraft}
            aria-valuetext={labels.seconds(intervalDraft)}
            disabled={requesting}
            onChange={(event) => setIntervalDraft(Number(event.currentTarget.value))}
            onPointerUp={(event) => commitInterval(event.currentTarget.value)}
            onKeyUp={(event) => commitInterval(event.currentTarget.value)}
            onBlur={(event) => commitInterval(event.currentTarget.value)}
          />
          <p className="screen-sharing-description screen-sharing-interval-hint">{labels.hint}</p>
          <div className="screen-sharing-interval-heading">
            <label className="screen-sharing-label" htmlFor="contact-sheet-frame-count">
              {labels.frameCount}
            </label>
            <output htmlFor="contact-sheet-frame-count">{frameCountDraft}</output>
          </div>
          <input
            id="contact-sheet-frame-count"
            className="screen-sharing-slider"
            type="range"
            min={0}
            max={CONTACT_SHEET_FRAME_COUNTS.length - 1}
            step={1}
            value={CONTACT_SHEET_FRAME_COUNTS.indexOf(
              frameCountDraft as (typeof CONTACT_SHEET_FRAME_COUNTS)[number],
            )}
            aria-valuetext={String(frameCountDraft)}
            disabled={requesting || publishedFrameCount === undefined}
            onChange={(event) =>
              setFrameCountDraft(CONTACT_SHEET_FRAME_COUNTS[Number(event.currentTarget.value)])
            }
            onPointerUp={(event) => commitFrameCount(event.currentTarget.value)}
            onKeyUp={(event) => commitFrameCount(event.currentTarget.value)}
            onBlur={(event) => commitFrameCount(event.currentTarget.value)}
          />
          {
            <CameraPreviewToggle
              visible={state.previewVisible ?? true}
              disabled={requesting}
              language={state.language}
              onChange={(visible) => void request({ type: "set-preview-visible", visible })}
            />
          }
          {!camera && screenSourceKind === "display" ? (
            <ScreenPointerToggle
              enabled={
                pointerDraft && state.pointerRevision === pointerDraft.pointerRevision
                  ? pointerDraft.enabled
                  : state.pointersEnabled
              }
              ready={state.pointersReady}
              language={state.language}
              onChange={(enabled) => void request({ type: "set-pointers-enabled", enabled })}
              onRetry={state.hasError ? () => void request({ type: "retry-pointers" }) : undefined}
            />
          ) : null}

          {!state.available ? (
            <p className="screen-sharing-description">{labels.unavailable}</p>
          ) : null}
          {state.permissionKind ? (
            <MediaPermissionHelp kind={state.permissionKind} language={state.language} />
          ) : state.hasError || actionError ? (
            <p className="screen-sharing-error" role="alert">
              {actionError ?? labels.error}
            </p>
          ) : null}

          <button
            type="button"
            className="screen-sharing-action"
            data-active={state.active}
            disabled={
              (!state.active && state.busy && !camera && screenSourceKind === "region") ||
              (state.active || state.busy ? requesting : !canStart)
            }
            onClick={() => void request({ type: state.active || state.busy ? "stop" : "start" })}
          >
            {state.active
              ? labels.stop
              : state.busy
                ? !camera && screenSourceKind === "region"
                  ? labels.selecting
                  : labels.cancel
                : labels.start}
          </button>
        </>
      )}
    </main>
  );
}
