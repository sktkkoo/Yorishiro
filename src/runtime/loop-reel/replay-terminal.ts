import type { ITheme as XTermTheme } from "@xterm/xterm";
import { Terminal as XTerm } from "@xterm/xterm";
import { applyFixedRect, readPaddedFixedRect } from "../terminal-runtime/fixed-terminal-rect";
import {
  buildReplayTimeline,
  type ReplayFrame,
  type ReplayStreamEntry,
  replayDurationMs,
} from "./reel-player";
import type { SessionRecording } from "./types";

const REPLAY_THEME: XTermTheme = {
  background: "#0f1923",
  foreground: "#eceff4",
  cursor: "#4dd9cf",
  cursorAccent: "#0f1923",
  selectionBackground: "#243447",
  selectionForeground: "#eceff4",
};

export interface ReplayTerminal {
  /** live terminal と同じ terminal placeholder に replay xterm を重ねる。 */
  attachTo(container: HTMLElement): void;
  detachContainer(): void;
  /** 録画 stream を読み込み、開始時刻まで linear seek する。 */
  loadStream(recording: SessionRecording): void;
  play(speed?: number): void;
  /** from→to の window だけ連続再生し、到達したら pause する。 */
  playWindow(fromTimestamp: number, toTimestamp: number, speed?: number, onEnd?: () => void): void;
  pause(): void;
  /** keyframe なしの P0 seek。先頭から対象時刻まで fast-replay する。 */
  seekLinear(timestamp: number): void;
  /** replay の実再生位置を購読する。 */
  onPosition(listener: (timestamp: number) => void): { dispose(): void };
  setHidden(hidden: boolean): void;
  dispose(): void;
}

/**
 * PTY 非接続の replay 専用 xterm。
 *
 * 記録済みの ANSI stream と resize entry だけを `write()` / `resize()` で再描画する。
 * `onData` を登録せず、PTY write API も import しないため observation-only 境界を保つ。
 */
export function createReplayTerminal(): ReplayTerminal {
  return new ReplayTerminalImpl();
}

class ReplayTerminalImpl implements ReplayTerminal {
  private readonly term: XTerm;
  private readonly container: HTMLDivElement;
  private attachedContainer: HTMLElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private rafId = 0;
  private followRafId = 0;
  private recording: SessionRecording | null = null;
  private frames: readonly ReplayFrame[] = [];
  private nextFrameIndex = 0;
  private replayMs = 0;
  private lastTickAt = 0;
  private windowEndReplayMs: number | null = null;
  private windowEndCallback: (() => void) | null = null;
  private hidden = true;
  private disposed = false;
  private readonly positionListeners = new Set<(timestamp: number) => void>();

  constructor() {
    this.term = new XTerm({
      theme: { ...REPLAY_THEME },
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 13,
      cursorBlink: false,
      allowProposedApi: true,
      allowTransparency: true,
      scrollback: 5000,
    });

    this.container = document.createElement("div");
    this.container.className = "xterm-replay-container";
    this.container.style.position = "fixed";
    this.container.style.visibility = "hidden";
    this.container.style.pointerEvents = "none";
    this.container.style.zIndex = "2";
    this.container.style.overflow = "hidden";
    document.body.appendChild(this.container);
    this.term.open(this.container);
  }

  attachTo(container: HTMLElement): void {
    if (this.disposed) return;
    this.attachedContainer = container;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => this.syncAttachedRect());
      this.resizeObserver.observe(container);
    }
    window.addEventListener("resize", this.handleViewportResize);
    this.syncAttachedRect();
    if (!this.hidden) this.startFollowLoop();
  }

  detachContainer(): void {
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.handleViewportResize);
    this.stopFollowLoop();
    this.attachedContainer = null;
    this.container.style.visibility = "hidden";
  }

  loadStream(recording: SessionRecording): void {
    if (this.disposed) return;
    this.pause();
    this.recording = recording;
    this.frames = buildReplayTimeline(recording);
    this.replayMs = 0;
    this.nextFrameIndex = 0;
    this.term.reset();
  }

  play(speed = 1): void {
    if (this.disposed || !this.recording || this.frames.length === 0) return;
    this.pause();
    this.windowEndReplayMs = null;
    this.windowEndCallback = null;
    this.startPlayback(speed);
  }

  playWindow(fromTimestamp: number, toTimestamp: number, speed = 1, onEnd?: () => void): void {
    if (this.disposed || !this.recording) return;
    const start = Math.min(fromTimestamp, toTimestamp);
    const end = Math.max(fromTimestamp, toTimestamp);
    this.seekLinear(start);
    const targetReplayMs = replayMsForTimestamp(this.frames, end, this.recording.startedAt);
    if (targetReplayMs <= this.replayMs || this.frames.length === 0) {
      this.seekLinear(end);
      onEnd?.();
      return;
    }
    this.windowEndReplayMs = targetReplayMs;
    this.windowEndCallback = onEnd ?? null;
    this.startPlayback(speed);
  }

  pause(): void {
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.windowEndReplayMs = null;
    this.windowEndCallback = null;
  }

  seekLinear(timestamp: number): void {
    if (this.disposed || !this.recording) return;
    this.pause();
    this.term.reset();
    for (const frame of this.frames) {
      if (frame.timestamp > timestamp) break;
      this.applyEntry(frame.entry);
    }
    this.replayMs = replayMsForTimestamp(this.frames, timestamp, this.recording.startedAt);
    this.nextFrameIndex = nextFrameIndexForReplayMs(this.frames, this.replayMs);
    this.notifyPosition();
  }

  onPosition(listener: (timestamp: number) => void): { dispose(): void } {
    this.positionListeners.add(listener);
    return {
      dispose: () => {
        this.positionListeners.delete(listener);
      },
    };
  }

  setHidden(hidden: boolean): void {
    this.hidden = hidden;
    this.container.style.visibility = hidden ? "hidden" : "visible";
    if (hidden) {
      this.stopFollowLoop();
    } else {
      this.syncAttachedRect();
      this.startFollowLoop();
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pause();
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    window.removeEventListener("resize", this.handleViewportResize);
    this.stopFollowLoop();
    this.term.dispose();
    this.container.remove();
  }

  private readonly handleViewportResize = (): void => {
    this.syncAttachedRect();
  };

  private startPlayback(speed = 1): void {
    if (this.disposed || !this.recording || this.frames.length === 0) return;
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    const safeSpeed = Number.isFinite(speed) && speed > 0 ? speed : 1;
    this.lastTickAt = performance.now();
    const tick = (now: number): void => {
      if (this.disposed || this.recording === null) return;
      const elapsed = Math.max(0, now - this.lastTickAt) * safeSpeed;
      this.lastTickAt = now;
      const playbackEnd = this.windowEndReplayMs ?? replayDurationMs(this.frames);
      const nextReplayMs = Math.min(
        playbackEnd,
        replayDurationMs(this.frames),
        this.replayMs + elapsed,
      );
      while (
        this.nextFrameIndex < this.frames.length &&
        this.frames[this.nextFrameIndex].dueMs <= nextReplayMs
      ) {
        const frame = this.frames[this.nextFrameIndex];
        this.nextFrameIndex += 1;
        if (frame.dueMs <= this.replayMs) continue;
        this.applyEntry(frame.entry);
      }
      this.replayMs = nextReplayMs;
      this.notifyPosition();
      const finished =
        this.replayMs >= playbackEnd || this.replayMs >= replayDurationMs(this.frames);
      if (!finished) {
        this.rafId = requestAnimationFrame(tick);
      } else {
        this.rafId = 0;
        const callback = this.windowEndCallback;
        this.windowEndReplayMs = null;
        this.windowEndCallback = null;
        callback?.();
      }
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private startFollowLoop(): void {
    if (this.followRafId !== 0 || !this.attachedContainer) return;
    const tick = (): void => {
      if (this.disposed || this.hidden || !this.attachedContainer) {
        this.followRafId = 0;
        return;
      }
      this.syncAttachedRect();
      this.followRafId = requestAnimationFrame(tick);
    };
    this.followRafId = requestAnimationFrame(tick);
  }

  private stopFollowLoop(): void {
    if (this.followRafId !== 0) {
      cancelAnimationFrame(this.followRafId);
      this.followRafId = 0;
    }
  }

  private syncAttachedRect(): void {
    const attached = this.attachedContainer;
    if (!attached) return;
    applyFixedRect(this.container, readPaddedFixedRect(attached), this.hidden);
    this.syncReplayScale();
  }

  private applyEntry(entry: ReplayStreamEntry): void {
    if (entry.kind === "pty") {
      this.term.write(entry.text);
      return;
    }
    this.term.resize(entry.cols, entry.rows);
    this.syncReplayScale();
  }

  private notifyPosition(): void {
    const recording = this.recording;
    if (!recording) return;
    const timestamp = timestampForReplayMs(this.frames, this.replayMs, recording.startedAt);
    for (const listener of Array.from(this.positionListeners)) {
      listener(timestamp);
    }
  }

  private syncReplayScale(): void {
    const xterm = this.container.querySelector<HTMLElement>(".xterm");
    if (!xterm) return;
    xterm.style.transform = "";
    xterm.style.transformOrigin = "top left";
    const viewport = this.container.getBoundingClientRect();
    const content = xterm.getBoundingClientRect();
    if (viewport.width <= 0 || viewport.height <= 0 || content.width <= 0 || content.height <= 0) {
      return;
    }
    const scale = Math.min(1, viewport.width / content.width, viewport.height / content.height);
    xterm.style.transform = scale < 1 ? `scale(${scale})` : "";
  }
}

const replayMsForTimestamp = (
  frames: readonly ReplayFrame[],
  timestamp: number,
  fallbackTimestamp: number,
): number => {
  let previousReplayMs = 0;
  let previousTimestamp = fallbackTimestamp;
  for (const frame of frames) {
    if (timestamp <= frame.timestamp) {
      const timestampSpan = frame.timestamp - previousTimestamp;
      if (timestampSpan <= 0) return frame.dueMs;
      const progress = Math.min(1, Math.max(0, (timestamp - previousTimestamp) / timestampSpan));
      return previousReplayMs + (frame.dueMs - previousReplayMs) * progress;
    }
    previousReplayMs = frame.dueMs;
    previousTimestamp = frame.timestamp;
  }
  return previousReplayMs;
};

const timestampForReplayMs = (
  frames: readonly ReplayFrame[],
  replayMs: number,
  fallbackTimestamp: number,
): number => {
  if (frames.length === 0) return fallbackTimestamp;
  let previousDueMs = 0;
  let previousTimestamp = fallbackTimestamp;
  for (const frame of frames) {
    if (replayMs <= frame.dueMs) {
      const span = frame.dueMs - previousDueMs;
      if (span <= 0) return frame.timestamp;
      const progress = Math.min(1, Math.max(0, (replayMs - previousDueMs) / span));
      return Math.round(previousTimestamp + (frame.timestamp - previousTimestamp) * progress);
    }
    previousDueMs = frame.dueMs;
    previousTimestamp = frame.timestamp;
  }
  return frames[frames.length - 1].timestamp;
};

const nextFrameIndexForReplayMs = (frames: readonly ReplayFrame[], replayMs: number): number => {
  let index = 0;
  while (index < frames.length && frames[index].dueMs <= replayMs) index += 1;
  return index;
};
