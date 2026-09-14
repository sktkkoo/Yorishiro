import type { Body, LipSyncSource } from "../core/body";
import { ensureAudioContextRunning } from "../core/voice/audio-context";
import { clearMouthValues, copyMouthValues, createMouthValues } from "../core/voice/mouth-values";
import { VoicePlayer } from "../core/voice/voice-player";
import { createBodyStateExpressionAdapter } from "../runtime/agent-state-expression/body-adapter";
import { createVoiceStateExpressionBridge } from "../runtime/agent-state-expression/voice-state-expression-bridge";

type SpeechBody = Pick<
  Body,
  | "acquireSemanticMotion"
  | "acquireSpeechStateExpression"
  | "setMotionConversationPhase"
  | "setLipSyncSource"
>;

export interface MotionLabSpeechState {
  readonly status: "idle" | "loading" | "playing" | "error";
  readonly text: string;
  readonly message: string;
}

const SAMPLE_BASE = "/.motion-review/speech-sample/";

/** Uses the real VoicePlayer clock and one shared analyser sample for both lanes. */
export class MotionLabSpeech {
  private player: VoicePlayer | null = null;
  private generation = 0;
  private pending: AbortController | null = null;
  private disposed = false;
  private readonly mouth = createMouthValues();
  private state: MotionLabSpeechState = { status: "idle", text: "", message: "Ready to play" };
  private readonly events: Array<{ type: string; atMs: number }> = [];
  private readonly lipSync: LipSyncSource = {
    isMouthActive: () => this.player?.isMouthActive() ?? false,
    sampleMouth: (out) => copyMouthValues(this.mouth, out ?? createMouthValues()),
  };
  private readonly bridge;

  constructor(
    private readonly bodies: readonly SpeechBody[],
    private readonly onChange: (state: MotionLabSpeechState) => void,
  ) {
    const adapters = bodies.map((body) => createBodyStateExpressionAdapter(() => body));
    this.bridge = createVoiceStateExpressionBridge({
      onConversationPhaseChange: (phase) => {
        this.record(`phase:${phase}`);
        for (const adapter of adapters) adapter.onConversationPhaseChange?.(phase);
      },
      onCue: (cue, context) => {
        this.record(`cue:${cue.state}`);
        for (const adapter of adapters) adapter.onCue(cue, context);
      },
      onRelease: (id, reason) => {
        this.record(`release:${reason}`);
        for (const adapter of adapters) adapter.onRelease(id, reason);
      },
    });
    for (const body of bodies) body.setLipSyncSource(this.lipSync);
  }

  /** Called only by the user's Play button; no loading or speech starts in construction. */
  async play(): Promise<void> {
    if (this.disposed) return;
    this.stop();
    const generation = this.generation;
    const pending = new AbortController();
    this.pending = pending;
    this.setState("loading", "Loading local speech sample…");
    try {
      // Resume within the click gesture, before awaiting local file IO.
      const context = await ensureAudioContextRunning();
      const manifestResponse = await fetch(`${SAMPLE_BASE}sample.json`, { signal: pending.signal });
      if (!manifestResponse.ok) throw new Error("Local speech sample has not been generated");
      const manifest = (await manifestResponse.json()) as { text?: unknown; voice?: unknown };
      if (typeof manifest.text !== "string" || !manifest.text.trim()) {
        throw new Error("Local speech manifest has no text");
      }
      const audioResponse = await fetch(`${SAMPLE_BASE}sample.wav`, { signal: pending.signal });
      if (!audioResponse.ok) throw new Error("Local speech WAV is missing");
      const bytes = await audioResponse.arrayBuffer();
      // Keep invalid fixtures out of VoicePlayer's native fallback in this browser-only lab.
      await context.decodeAudioData(bytes.slice(0));
      if (generation !== this.generation || this.disposed) return;
      this.pending = null;
      const text = manifest.text;
      this.state = { ...this.state, text };
      const player = new VoicePlayer(
        typeof manifest.voice === "string" ? manifest.voice : undefined,
        {
          name: "local-review-fixture",
          synthesize: async (requested) => {
            if (requested !== text) throw new Error("Speech fixture text does not match its audio");
            return bytes.slice(0);
          },
        },
        {
          onPrepared: (id, preparedText) => this.bridge.onPrepared(id, preparedText),
          onStarted: (id, startedAtMs) => {
            this.record("audio:started", startedAtMs);
            this.bridge.onStarted(id, startedAtMs);
            if (generation === this.generation) this.setState("playing", "Playing local speech");
          },
          onEnded: (id, reason) => {
            this.record(`audio:${reason}`);
            this.bridge.onEnded(id, reason);
          },
        },
      );
      this.player = player;
      const handle = player.createVoiceAPI().say(text);
      await handle.completion;
      if (generation !== this.generation) return;
      this.player = null;
      player.dispose();
      clearMouthValues(this.mouth);
      this.setState("idle", "Speech finished");
    } catch (error) {
      if (generation !== this.generation || this.disposed) return;
      this.stop();
      this.setState("error", `${String(error)}. Run node scripts/prepare-motion-speech-sample.mjs`);
    } finally {
      if (this.pending === pending) this.pending = null;
    }
  }

  /** Cancels pending loading and real audio/cues; it never resumes a stale request. */
  stop(message = "Speech stopped"): void {
    this.generation++;
    this.pending?.abort();
    this.pending = null;
    const player = this.player;
    this.player = null;
    // dispose avoids the native tts_stop call in VoiceHandle.stop in a Vite page.
    player?.dispose();
    clearMouthValues(this.mouth);
    if (this.state.status === "playing" || this.state.status === "loading") {
      this.setState("idle", message);
    }
  }

  sampleFrame(): void {
    if (this.player?.isMouthActive()) this.player.sampleMouth(this.mouth);
    else clearMouthValues(this.mouth);
  }

  isBusy(): boolean {
    return this.state.status === "playing" || this.state.status === "loading";
  }

  snapshot() {
    return { ...this.state, mouth: { ...this.mouth }, events: this.events.slice() };
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    for (const body of this.bodies) body.setLipSyncSource(null);
  }

  private record(type: string, atMs = performance.now()): void {
    this.events.push({ type, atMs });
    if (this.events.length > 100) this.events.shift();
  }

  private setState(status: MotionLabSpeechState["status"], message: string): void {
    this.state = { ...this.state, status, message };
    this.onChange(this.state);
  }
}
