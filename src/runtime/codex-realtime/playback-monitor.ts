import { captureOutputTiming, type OutputTimingSample } from "./output-timing";
import { isRealtimeDebugEnabled, subscribeRealtimeDebug } from "./realtime-debug";

/** Numeric/state-only output evidence. Never includes SDP, transcripts, track IDs or device labels. */
export interface PlaybackSample {
  readonly contextState: string;
  readonly outputTiming: OutputTimingSample;
  readonly gain: number;
  readonly analyserSignal: boolean;
  readonly liveRemoteTracks: number;
  readonly mutedRemoteTracks: number;
  readonly inboundAudioBytes?: number;
  readonly inboundAudioPackets?: number;
  readonly statsAvailable: boolean;
}

interface PlaybackMonitorOptions {
  readonly context: AudioContext;
  readonly stream: MediaStream;
  readonly peer: RTCPeerConnection;
  readonly gain: () => number;
  readonly hasSignal: () => boolean;
  readonly onSample: (sample: PlaybackSample) => void;
  readonly onFailure: (error: Error) => void;
}

/** Owns observers, never the shared context. Stopping one client cannot close another's context. */
export function monitorPlayback(options: PlaybackMonitorOptions): () => void {
  let disposed = false;
  let resuming = false;
  let sampling = false;
  let diagnosticsGeneration = 0;
  let timer: ReturnType<typeof globalThis.setInterval> | undefined;
  let resumeTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const { context, stream, peer } = options;
  const state = () => context.state as AudioContextState | "interrupted";
  const sample = async () => {
    if (disposed || sampling || !isRealtimeDebugEnabled()) return;
    const generation = diagnosticsGeneration;
    sampling = true;
    let inboundAudioBytes: number | undefined;
    let inboundAudioPackets: number | undefined;
    let statsAvailable = false;
    try {
      const stats = await peer.getStats();
      statsAvailable = true;
      stats.forEach((entry) => {
        if (entry.type !== "inbound-rtp" || (entry.kind ?? entry.mediaType) !== "audio") return;
        if (Number.isFinite(entry.bytesReceived) && entry.bytesReceived >= 0)
          inboundAudioBytes = (inboundAudioBytes ?? 0) + entry.bytesReceived;
        if (Number.isFinite(entry.packetsReceived) && entry.packetsReceived >= 0)
          inboundAudioPackets = (inboundAudioPackets ?? 0) + entry.packetsReceived;
      });
    } catch {
      // Unsupported stats do not interfere with playback or fabricate zero receipt.
    } finally {
      sampling = false;
    }
    if (disposed || generation !== diagnosticsGeneration || !isRealtimeDebugEnabled()) return;
    const tracks = stream.getAudioTracks();
    options.onSample({
      contextState: state(),
      outputTiming: captureOutputTiming(context),
      gain: options.gain(),
      analyserSignal: options.hasSignal(),
      liveRemoteTracks: tracks.filter((track) => track.readyState === "live").length,
      mutedRemoteTracks: tracks.filter((track) => track.muted).length,
      inboundAudioBytes,
      inboundAudioPackets,
      statsAvailable,
    });
  };
  const recover = async () => {
    if (disposed || resuming || state() === "running") return;
    if (state() === "closed") {
      options.onFailure(new Error("Voice output closed. Turn voice off and on to reconnect."));
      return;
    }
    resuming = true;
    try {
      await Promise.race([
        context.resume(),
        new Promise<never>((_, reject) => {
          resumeTimeout = globalThis.setTimeout(
            () => reject(new Error("Output resume timed out")),
            5_000,
          );
        }),
      ]);
      if (disposed) return;
      if (state() !== "running") throw new Error("Output context did not resume");
      void sample();
    } catch {
      if (!disposed)
        options.onFailure(
          new Error("Voice output could not resume. Turn voice off and on to reconnect."),
        );
    } finally {
      globalThis.clearTimeout(resumeTimeout);
      resumeTimeout = undefined;
      resuming = false;
    }
  };
  const stateChanged = () => {
    void sample();
    void recover();
  };
  const foreground = () => void recover();
  context.addEventListener("statechange", stateChanged);
  window.addEventListener("focus", foreground);
  window.addEventListener("pointerdown", foreground);
  window.addEventListener("keydown", foreground);
  const refreshDiagnostics = () => {
    diagnosticsGeneration++;
    globalThis.clearInterval(timer);
    timer = undefined;
    if (!disposed && isRealtimeDebugEnabled()) {
      timer = globalThis.setInterval(() => void sample(), 5_000);
      void sample();
    }
  };
  const unsubscribeDebug = subscribeRealtimeDebug(refreshDiagnostics);
  refreshDiagnostics();
  return () => {
    disposed = true;
    unsubscribeDebug();
    globalThis.clearTimeout(resumeTimeout);
    globalThis.clearInterval(timer);
    context.removeEventListener("statechange", stateChanged);
    window.removeEventListener("focus", foreground);
    window.removeEventListener("pointerdown", foreground);
    window.removeEventListener("keydown", foreground);
  };
}
