import { LoaderCircle, MonitorUp, RefreshCw, X } from "lucide-react";
import { type CSSProperties, useEffect, useId, useRef, useState } from "react";
import "./screen-sharing-control.css";

export interface ScreenSharingControlProps {
  readonly available: boolean;
  readonly active: boolean;
  readonly busy: boolean;
  readonly intervalSeconds: number;
  readonly sources: readonly { readonly id: number; readonly name: string }[];
  readonly sourceId: number | null;
  readonly error?: string;
  readonly lastObservedAt?: number;
  readonly onIntervalChange: (value: number) => void;
  readonly onSourceChange: (id: number) => void;
  readonly onStart: () => void;
  readonly onStop: () => void;
  readonly onRefreshSources: () => void;
  readonly language?: string;
}

const strings = {
  en: {
    title: "Screen sharing",
    activeTitle: "Screen sharing on",
    close: "Close screen sharing settings",
    description:
      "Share the selected display with your main agent. Ask about the screen to have it inspect the image.",
    display: "Display",
    chooseDisplay: "Choose a display",
    noDisplays: "No displays available",
    refresh: "Refresh displays",
    interval: "Viewing interval",
    seconds: (value: number) => `${value} seconds`,
    cost: "Screen sharing sends images and can use many tokens. Shorter intervals increase usage.",
    unavailable: "Select an agent that supports screen sharing to start.",
    on: "Sharing",
    off: "Off",
    busy: "Sharing image…",
    waiting: "Waiting for the first image…",
    stopped: "Screen sharing is off.",
    lastViewed: "Last shared",
    cancel: "Cancel",
    start: "Start sharing",
    stop: "Stop sharing",
  },
  ja: {
    title: "画面共有",
    activeTitle: "画面共有中",
    close: "画面共有の設定を閉じる",
    description:
      "選択した画面をメインエージェントに共有します。画面について話しかけると、画像を参照します。",
    display: "共有する画面",
    chooseDisplay: "画面を選択",
    noDisplays: "共有できる画面がありません",
    refresh: "画面一覧を更新",
    interval: "画面を見る間隔",
    seconds: (value: number) => `${value}秒`,
    cost: "画面共有は画像の送信でトークンを多く消費します。間隔が短いほど使用量が増えます。",
    unavailable: "画面共有に対応するエージェントを選択してください。",
    on: "共有中",
    off: "停止中",
    busy: "画像を共有中…",
    waiting: "最初の画像の共有を待っています…",
    stopped: "画面共有は停止しています。",
    lastViewed: "最終共有",
    cancel: "キャンセル",
    start: "共有を開始",
    stop: "共有を停止",
  },
} as const;

/** Controlled screen-sharing settings. Opening the panel never starts capture. */
export function ScreenSharingControl({
  available,
  active,
  busy,
  intervalSeconds,
  sources,
  sourceId,
  error,
  lastObservedAt,
  onIntervalChange,
  onSourceChange,
  onStart,
  onStop,
  onRefreshSources,
  language = "en",
}: ScreenSharingControlProps) {
  const [open, setOpen] = useState(false);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});
  const rootRef = useRef<HTMLFieldSetElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const titleId = useId();
  const descriptionId = useId();
  const displayId = useId();
  const intervalId = useId();
  const costId = useId();
  const isJapanese = language.startsWith("ja");
  const labels = strings[isJapanese ? "ja" : "en"];
  const hasSelectedSource = sources.some((source) => source.id === sourceId);
  const canStart = available && hasSelectedSource && !busy;
  const lastViewed =
    lastObservedAt !== undefined && Number.isFinite(lastObservedAt)
      ? new Date(lastObservedAt).toLocaleTimeString(isJapanese ? "ja-JP" : "en-US", {
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
        })
      : null;

  const openPanel = () => {
    setOpen(true);
    if (!active) onRefreshSources();
  };

  useEffect(() => {
    if (!open) return;
    const positionPanel = () => {
      const width = Math.min(310, Math.max(0, window.innerWidth - 24));
      const rect = triggerRef.current?.getBoundingClientRect();
      const top = Math.min((rect?.bottom ?? 32) + 8, Math.max(12, window.innerHeight - 100));
      setPanelStyle({
        left: Math.max(12, Math.min(rect?.left ?? 12, window.innerWidth - width - 12)),
        top,
        width,
        maxHeight: Math.max(0, window.innerHeight - top - 12),
      });
    };
    positionPanel();
    window.addEventListener("resize", positionPanel);
    closeRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <fieldset
      className="screen-sharing-control"
      aria-label={labels.title}
      ref={rootRef}
      onBlur={(event) => {
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setOpen(false);
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={`title-bar-button screen-sharing-trigger${active || open ? " is-active" : ""}`}
        data-sharing-active={active}
        aria-label={active ? labels.activeTitle : labels.title}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        title={error ?? (active ? labels.activeTitle : labels.title)}
        onClick={() => (open ? setOpen(false) : openPanel())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) openPanel();
          }
        }}
      >
        <MonitorUp size={15} strokeWidth={1.8} aria-hidden="true" />
        {active ? <span className="screen-sharing-dot" aria-hidden="true" /> : null}
      </button>
      {open ? (
        <div
          id={panelId}
          className="screen-sharing-panel"
          style={panelStyle}
          role="dialog"
          aria-labelledby={titleId}
          aria-describedby={descriptionId}
        >
          <div className="screen-sharing-heading">
            <h2 id={titleId}>{labels.title}</h2>
            <span className="screen-sharing-badge" data-active={active}>
              {active ? labels.on : labels.off}
            </span>
            <button
              ref={closeRef}
              type="button"
              className="screen-sharing-icon-button"
              aria-label={labels.close}
              onClick={() => {
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <X size={14} aria-hidden="true" />
            </button>
          </div>
          <p className="screen-sharing-description" id={descriptionId}>
            {labels.description}
          </p>
          <label className="screen-sharing-label" htmlFor={displayId}>
            {labels.display}
          </label>
          <div className="screen-sharing-source-row">
            <select
              id={displayId}
              value={hasSelectedSource ? (sourceId ?? "") : ""}
              disabled={active || busy || !available || sources.length === 0}
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
            <button
              type="button"
              className="screen-sharing-icon-button"
              aria-label={labels.refresh}
              title={labels.refresh}
              disabled={active || busy || !available}
              onClick={onRefreshSources}
            >
              <RefreshCw size={14} aria-hidden="true" />
            </button>
          </div>
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
            min={5}
            max={60}
            step={1}
            value={intervalSeconds}
            aria-valuetext={labels.seconds(intervalSeconds)}
            aria-describedby={costId}
            onChange={(event) => onIntervalChange(Number(event.currentTarget.value))}
          />
          <div className="screen-sharing-range-labels" aria-hidden="true">
            <span>{labels.seconds(5)}</span>
            <span>{labels.seconds(60)}</span>
          </div>
          <p className="screen-sharing-cost" id={costId}>
            {labels.cost}
          </p>
          {!available ? <p className="screen-sharing-description">{labels.unavailable}</p> : null}
          {error ? (
            <p className="screen-sharing-error" role="alert">
              {error}
            </p>
          ) : (
            <div className="screen-sharing-status" role="status" aria-live="polite">
              {busy ? (
                <>
                  <LoaderCircle size={13} className="screen-sharing-spinner" aria-hidden="true" />
                  <span>{labels.busy}</span>
                </>
              ) : lastViewed ? (
                <span>
                  {labels.lastViewed}: {lastViewed}
                </span>
              ) : (
                <span>{active ? labels.waiting : labels.stopped}</span>
              )}
            </div>
          )}
          <button
            type="button"
            className="screen-sharing-action"
            data-active={active}
            disabled={!active && !busy && !canStart}
            aria-describedby={!active ? costId : undefined}
            onClick={active || busy ? onStop : onStart}
          >
            {active ? labels.stop : busy ? labels.cancel : labels.start}
          </button>
        </div>
      ) : null}
    </fieldset>
  );
}
