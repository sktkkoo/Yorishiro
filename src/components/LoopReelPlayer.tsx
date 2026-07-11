import {
  AlertTriangle,
  Circle,
  Eye,
  EyeOff,
  Pause,
  Play,
  SkipBack,
  SkipForward,
  Square,
  X,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  buildIterationClips,
  clampTimestamp,
  createReplayTerminal,
  endedLoopReelMetas,
  type LoopReelPersistedMeta,
  type LoopReelPersistenceController,
  type LoopReelRedactionSources,
  type LoopReelStore,
  loadLoopReelRedactionSources,
  mergeLoopReelMetas,
  nextClipTimestamp,
  nextFailedTimestamp,
  phaseMarkersOfRecording,
  previousClipTimestamp,
  type ReplayTerminal,
  recordingTimeRange,
  redactLoopReelRecording,
  resolveReplayTerminalSurface,
  type SessionRecording,
} from "../runtime/loop-reel";

interface LoopReelPlayerProps {
  readonly open: boolean;
  readonly store: LoopReelStore;
  readonly persistence: LoopReelPersistenceController;
  /** active session が録画中か（App が store を購読して算出）。 */
  readonly recordingActive: boolean;
  /** active session の手動録画を開始/停止する。loop_announce が無い session の dogfooding 用。 */
  readonly onToggleRecording: () => void;
  readonly onClose: () => void;
}

interface SurfaceBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const EMPTY_REDACTION_SOURCES: LoopReelRedactionSources = {
  username: null,
  homeBasename: null,
  hostname: null,
  gitUserName: null,
  gitUserEmail: null,
};

// 実機調整前提: placement と操作感の値は dogfooding 後にまとめて詰める。
const PLAYER_UI = {
  surfaceRetryMs: 250,
  refreshDebounceMs: 300,
  controlBarHeight: 46,
  markerSize: 9,
} as const;

const PLAYER_SPEEDS = [1, 2, 4] as const;

export function LoopReelPlayer({
  open,
  store,
  persistence,
  recordingActive,
  onToggleRecording,
  onClose,
}: LoopReelPlayerProps) {
  const replayRef = useRef<ReplayTerminal | null>(null);
  const positionRef = useRef(0);
  const redactionRequestRef = useRef<Promise<LoopReelRedactionSources> | null>(null);
  const refreshRequestIdRef = useRef(0);
  const refreshTimerRef = useRef<number | null>(null);
  const [surfaceBox, setSurfaceBox] = useState<SurfaceBox | null>(null);
  const [metas, setMetas] = useState<readonly LoopReelPersistedMeta[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [recording, setRecording] = useState<SessionRecording | null>(null);
  const [position, setPosition] = useState(0);
  const [speed, setSpeed] = useState<(typeof PLAYER_SPEEDS)[number]>(1);
  const [playing, setPlaying] = useState(false);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingRecording, setLoadingRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [redactionEnabled, setRedactionEnabled] = useState(false);
  const [redactionSources, setRedactionSources] = useState<LoopReelRedactionSources | null>(null);
  const [redactionLoading, setRedactionLoading] = useState(false);

  const endedMetas = useMemo(() => endedLoopReelMetas(metas), [metas]);
  const displayRecording = useMemo(() => {
    if (!recording || !redactionEnabled) return recording;
    return redactLoopReelRecording(recording, redactionSources ?? EMPTY_REDACTION_SOURCES);
  }, [recording, redactionEnabled, redactionSources]);
  const range = useMemo(() => (recording ? recordingTimeRange(recording) : null), [recording]);
  const clips = useMemo(() => (recording ? buildIterationClips(recording) : []), [recording]);
  const markers = useMemo(() => (recording ? phaseMarkersOfRecording(recording) : []), [recording]);
  const previousClip = useMemo(() => previousClipTimestamp(clips, position), [clips, position]);
  const nextClip = useMemo(() => nextClipTimestamp(clips, position), [clips, position]);
  const nextFailed = useMemo(
    () => (recording ? nextFailedTimestamp(recording, position) : null),
    [recording, position],
  );

  const setCurrentPosition = useCallback((timestamp: number) => {
    positionRef.current = timestamp;
    setPosition(timestamp);
  }, []);

  const refreshList = useCallback(
    async (options: { flush: boolean; showLoading: boolean }) => {
      const requestId = refreshRequestIdRef.current + 1;
      refreshRequestIdRef.current = requestId;
      if (options.showLoading) setLoadingList(true);
      setError(null);
      try {
        if (options.flush) await persistence.flushAll();
        const persisted = await persistence.listRecordings();
        const merged = mergeLoopReelMetas(persisted, store.listMetas());
        if (requestId !== refreshRequestIdRef.current) return;
        const ended = endedLoopReelMetas(merged);
        setMetas(merged);
        setSelectedId((current) => {
          if (current && ended.some((meta) => meta.id === current)) return current;
          return ended[0]?.id ?? null;
        });
      } catch (err) {
        if (requestId === refreshRequestIdRef.current) {
          setError(`Loop Reel load failed: ${stringifyError(err)}`);
        }
      } finally {
        if (options.showLoading && requestId === refreshRequestIdRef.current) {
          setLoadingList(false);
        }
      }
    },
    [persistence, store],
  );

  useEffect(() => {
    if (!open) return;
    setRedactionEnabled(false);
    setPlaying(false);
    void refreshList({ flush: true, showLoading: true });
    const subscription = store.subscribe(() => {
      // 実機調整前提: PTY append ごとの点滅を避け、一覧更新だけを trailing でまとめる。
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refreshList({ flush: false, showLoading: false });
      }, PLAYER_UI.refreshDebounceMs);
    });
    return () => {
      refreshRequestIdRef.current += 1;
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      subscription.dispose();
    };
  }, [open, refreshList, store]);

  useEffect(() => {
    if (!open) return;
    const replay = createReplayTerminal();
    replayRef.current = replay;
    const positionSubscription = replay.onPosition((timestamp) => {
      setCurrentPosition(timestamp);
    });
    let disposed = false;
    let retryTimer: number | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const setBoxFromSurface = (surface: HTMLElement) => {
      const rect = surface.getBoundingClientRect();
      const next = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
      setSurfaceBox((current) => (sameSurfaceBox(current, next) ? current : next));
    };

    const syncSurface = () => {
      if (disposed) return;
      const surface = resolveReplayTerminalSurface();
      if (!surface) {
        retryTimer = window.setTimeout(syncSurface, PLAYER_UI.surfaceRetryMs);
        return;
      }
      replay.attachTo(surface);
      replay.setHidden(false);
      setBoxFromSurface(surface);
      resizeObserver?.disconnect();
      resizeObserver =
        typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncSurface);
      resizeObserver?.observe(surface);
    };

    syncSurface();
    window.addEventListener("resize", syncSurface);
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      resizeObserver?.disconnect();
      window.removeEventListener("resize", syncSurface);
      positionSubscription.dispose();
      replay.dispose();
      replayRef.current = null;
      setSurfaceBox(null);
    };
  }, [open, setCurrentPosition]);

  useEffect(() => {
    if (!open || !selectedId) {
      setRecording(null);
      return;
    }
    let cancelled = false;
    setLoadingRecording(true);
    setError(null);
    void persistence
      .loadRecording(selectedId)
      .then((loaded) => {
        if (cancelled) return;
        setRecording(loaded);
        if (!loaded) {
          setError("Loop Reel recording not found.");
          return;
        }
        const nextRange = recordingTimeRange(loaded);
        setCurrentPosition(nextRange.fromTs);
      })
      .catch((err) => {
        if (!cancelled) setError(`Loop Reel load failed: ${stringifyError(err)}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingRecording(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, persistence, selectedId, setCurrentPosition]);

  useEffect(() => {
    const replay = replayRef.current;
    if (!open || !displayRecording || !replay) return;
    const nextRange = recordingTimeRange(displayRecording);
    const timestamp = clampTimestamp(positionRef.current, nextRange);
    replay.loadStream(displayRecording);
    replay.seekLinear(timestamp);
    replay.setHidden(false);
    setCurrentPosition(timestamp);
    setPlaying(false);
  }, [displayRecording, open, setCurrentPosition]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => {
      window.removeEventListener("keydown", onKeyDown, { capture: true });
    };
  }, [onClose, open]);

  const seekTo = useCallback(
    (timestamp: number) => {
      if (!range) return;
      const clamped = clampTimestamp(timestamp, range);
      replayRef.current?.seekLinear(clamped);
      setCurrentPosition(clamped);
      setPlaying(false);
    },
    [range, setCurrentPosition],
  );

  const playFromCurrent = useCallback(
    (nextSpeed = speed) => {
      if (!range || !displayRecording) return;
      const start = positionRef.current >= range.toTs ? range.fromTs : positionRef.current;
      replayRef.current?.loadStream(displayRecording);
      replayRef.current?.playWindow(start, range.toTs, nextSpeed, () => {
        setPlaying(false);
        setCurrentPosition(range.toTs);
      });
      setCurrentPosition(start);
      setPlaying(true);
    },
    [displayRecording, range, setCurrentPosition, speed],
  );

  const pause = useCallback(() => {
    replayRef.current?.pause();
    setPlaying(false);
  }, []);

  const toggleRedaction = useCallback(async () => {
    if (redactionEnabled) {
      setRedactionEnabled(false);
      return;
    }
    setRedactionLoading(true);
    setError(null);
    try {
      redactionRequestRef.current ??= loadLoopReelRedactionSources();
      setRedactionSources(await redactionRequestRef.current);
      setRedactionEnabled(true);
    } catch (err) {
      redactionRequestRef.current = null;
      setRedactionSources(EMPTY_REDACTION_SOURCES);
      setError(`Loop Reel mask source load failed: ${stringifyError(err)}`);
    } finally {
      setRedactionLoading(false);
    }
  }, [redactionEnabled]);

  if (!open) return null;

  const hasPlayableRecording = endedMetas.length > 0;
  const inactiveReason =
    metas.length === 0
      ? "No loop recordings yet."
      : "Recording is still in progress. Finished recordings can be replayed here.";

  return (
    <div
      className="loop-reel-player-shell"
      style={surfaceBox ? boxStyle(surfaceBox) : undefined}
      aria-hidden={surfaceBox ? undefined : "true"}
    >
      <div className="loop-reel-player-status" data-visible={error ? "true" : "false"}>
        {error}
      </div>
      {!hasPlayableRecording ? (
        <div className="loop-reel-player-empty">{loadingList ? "Loading..." : inactiveReason}</div>
      ) : null}
      <div className="loop-reel-player-controls" style={{ minHeight: PLAYER_UI.controlBarHeight }}>
        <button
          type="button"
          className="loop-reel-player-record"
          data-recording={recordingActive ? "true" : "false"}
          onClick={onToggleRecording}
          aria-pressed={recordingActive}
          aria-label={recordingActive ? "Stop manual recording" : "Start manual recording"}
          title={recordingActive ? "Stop manual recording" : "Start manual recording"}
        >
          {recordingActive ? (
            <Square size={12} aria-hidden="true" />
          ) : (
            <Circle size={12} aria-hidden="true" />
          )}
          <span>REC</span>
        </button>
        <select
          className="loop-reel-player-select"
          value={selectedId ?? ""}
          onChange={(event) => {
            pause();
            setSelectedId(event.currentTarget.value || null);
          }}
          disabled={loadingList}
          aria-label="Loop Reel recording"
        >
          {metas.length === 0 ? <option value="">No recordings</option> : null}
          {metas.map((meta) => (
            <option
              key={meta.id}
              value={meta.status === "ended" ? meta.id : ""}
              disabled={meta.status !== "ended"}
            >
              {formatRecordingOption(meta)}
            </option>
          ))}
        </select>
        <IconButton
          label={playing ? "Pause Loop Reel" : "Play Loop Reel"}
          disabled={!recording || loadingRecording}
          onClick={() => (playing ? pause() : playFromCurrent())}
        >
          {playing ? <Pause size={15} aria-hidden="true" /> : <Play size={15} aria-hidden="true" />}
        </IconButton>
        <fieldset className="loop-reel-player-speed" aria-label="Loop Reel speed">
          {PLAYER_SPEEDS.map((value) => (
            <button
              key={value}
              type="button"
              className={value === speed ? "is-active" : ""}
              onClick={() => {
                setSpeed(value);
                if (playing) playFromCurrent(value);
              }}
            >
              {value}x
            </button>
          ))}
        </fieldset>
        <div className="loop-reel-player-scrubber">
          <div
            className="loop-reel-player-markers"
            aria-hidden={markers.length === 0 ? "true" : undefined}
          >
            {range
              ? markers.map((marker) => (
                  <button
                    key={`${marker.phase}-${marker.timestamp}`}
                    type="button"
                    className="loop-reel-player-marker"
                    data-phase={marker.phase}
                    style={{
                      left: `${markerLeft(marker.timestamp, range.fromTs, range.toTs)}%`,
                      width: PLAYER_UI.markerSize,
                      height: PLAYER_UI.markerSize,
                    }}
                    aria-label={`Jump to ${marker.phase}`}
                    title={marker.phase}
                    onClick={() => seekTo(marker.timestamp)}
                  />
                ))
              : null}
          </div>
          <input
            type="range"
            min={range?.fromTs ?? 0}
            max={range?.toTs ?? 1}
            step={1}
            value={range ? clampTimestamp(position, range) : 0}
            onChange={(event) => seekTo(Number(event.currentTarget.value))}
            disabled={!recording || !range}
            aria-label="Loop Reel position"
          />
        </div>
        <span className="loop-reel-player-time">
          {range ? formatOffset(position - range.fromTs) : "00:00"}
        </span>
        <IconButton
          label="Previous Loop Reel clip"
          disabled={previousClip === null}
          onClick={() => {
            if (previousClip !== null) seekTo(previousClip);
          }}
        >
          <SkipBack size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Next Loop Reel clip"
          disabled={nextClip === null}
          onClick={() => {
            if (nextClip !== null) seekTo(nextClip);
          }}
        >
          <SkipForward size={15} aria-hidden="true" />
        </IconButton>
        <IconButton
          label="Next failed Loop Reel marker"
          disabled={nextFailed === null}
          onClick={() => {
            if (nextFailed !== null) seekTo(nextFailed);
          }}
        >
          <AlertTriangle size={15} aria-hidden="true" />
        </IconButton>
        <button
          type="button"
          className="loop-reel-player-mask"
          data-enabled={redactionEnabled ? "true" : "false"}
          onClick={() => {
            void toggleRedaction();
          }}
          disabled={redactionLoading || !recording}
          aria-pressed={redactionEnabled}
          aria-label="Toggle Loop Reel mask"
          title="Toggle Loop Reel mask"
        >
          {redactionEnabled ? (
            <EyeOff size={14} aria-hidden="true" />
          ) : (
            <Eye size={14} aria-hidden="true" />
          )}
          <span>{redactionEnabled ? "MASKED" : "RAW"}</span>
        </button>
        <IconButton label="Close Loop Reel" onClick={onClose}>
          <X size={15} aria-hidden="true" />
        </IconButton>
      </div>
    </div>
  );
}

interface IconButtonProps {
  readonly label: string;
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly children: ReactNode;
}

function IconButton({ label, disabled = false, onClick, children }: IconButtonProps) {
  return (
    <button
      type="button"
      className="loop-reel-player-icon-button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
    >
      {children}
    </button>
  );
}

const sameSurfaceBox = (a: SurfaceBox | null, b: SurfaceBox): boolean =>
  a !== null &&
  Math.round(a.left) === Math.round(b.left) &&
  Math.round(a.top) === Math.round(b.top) &&
  Math.round(a.width) === Math.round(b.width) &&
  Math.round(a.height) === Math.round(b.height);

const boxStyle = (box: SurfaceBox): CSSProperties => ({
  left: box.left,
  top: box.top,
  width: box.width,
  height: box.height,
});

const markerLeft = (timestamp: number, fromTs: number, toTs: number): number => {
  const span = Math.max(1, toTs - fromTs);
  return Math.min(100, Math.max(0, ((timestamp - fromTs) / span) * 100));
};

const formatRecordingOption = (meta: LoopReelPersistedMeta): string => {
  const status = meta.status === "recording" ? " · 録画中" : "";
  return `${meta.label} · ${formatWallTime(meta.startedAt)}${status}`;
};

const formatWallTime = (timestamp: number): string => {
  const date = new Date(timestamp);
  const yyyy = date.getFullYear();
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const min = pad2(date.getMinutes());
  return `${yyyy}-${mm}-${dd} ${hh}:${min}`;
};

const formatOffset = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${pad2(minutes)}:${pad2(seconds)}`;
};

const pad2 = (value: number): string => String(value).padStart(2, "0");

const stringifyError = (err: unknown): string => (err instanceof Error ? err.message : String(err));
