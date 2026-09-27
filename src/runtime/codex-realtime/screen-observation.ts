import { screenCapturePrompt } from "./screen-sharing-prompts";

/** A single, explicitly shared screen capture. Image contents must never enter diagnostics. */
export interface ScreenObservationFrame {
  readonly sourceKind?: "screen" | "camera";
  /** Opaque native reference to this capture; revoked when its sharing lease ends. */
  readonly frameId: string;
  readonly width: number;
  readonly height: number;
  readonly imageDataUrl: string;
  readonly capturedAt: string;
  readonly source: string;
  /** Native pointer preference; omitted only by older callers. */
  readonly pointersEnabled?: boolean;
  /** False when a pointer setting transition invalidated this capture's reference. */
  readonly pointerFrameValid?: boolean;
  /** Native pointer epoch bound to this capture; old epochs cannot regain permission. */
  readonly pointerEpoch?: number;
}

export interface ScreenPointerAvailability {
  readonly sourceKind?: "screen" | "camera";
  readonly pointersEnabled: boolean;
  readonly pointerFrameValid: boolean;
}

export interface ScreenObservationResult {
  /** `shared` means delivered to the agent transport (context or on-demand cache), not interpreted. */
  readonly status: "shared" | "busy";
  readonly capturedAt: string;
}

export interface ScreenObservationTransportOptions {
  readonly request: (method: string, params: object) => Promise<unknown>;
  /** The connection owner supplies only its validated, selected, loaded main thread. */
  readonly getThreadId: () => string | null;
  readonly timeoutMs?: number;
}

/** Cancellation is expected when sharing stops or the selected thread changes. */
export class ScreenObservationCancelledError extends Error {
  constructor() {
    super("Screen sharing was cancelled");
    this.name = "AbortError";
  }
}

interface ObservationRun {
  readonly frame: ScreenObservationFrame;
  readonly threadId: string;
  readonly finish: (result?: ScreenObservationResult, error?: Error) => void;
  settled: boolean;
}

const DEFAULT_TIMEOUT_MS = 15_000;

function validFrame(frame: ScreenObservationFrame): boolean {
  return (
    typeof frame.frameId === "string" &&
    frame.frameId.trim().length > 0 &&
    frame.frameId.length <= 128 &&
    Number.isSafeInteger(frame.width) &&
    frame.width > 0 &&
    Number.isSafeInteger(frame.height) &&
    frame.height > 0 &&
    /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(frame.imageDataUrl) &&
    Number.isFinite(Date.parse(frame.capturedAt)) &&
    frame.source.trim().length > 0
  );
}

/**
 * Appends a screenshot to the existing main agent's model-visible context.
 *
 * `turn/start` can steer a concurrently started user turn, and its protocol has no
 * atomic idle-only guard. `thread/inject_items` instead appends context without
 * starting inference, steering a task, or interrupting a turn. Loaded active
 * threads also accept context, so a working main agent can receive screen updates
 * without waiting for its task to finish.
 * The tracker validates ownership/loading on selection and tracks unload events.
 * A second `thread/read` before every injection adds a round trip without making
 * the following send atomic. The server rejects an injection if unloading races
 * the send; it never starts or resumes a thread on our behalf.
 *
 * There is no capture queue. Cancellation/timeout settles the caller immediately,
 * but the transport remains busy until its outstanding RPC settles, preventing
 * repeated cancelled requests from accumulating. The injected request function
 * should have its own connection-level timeout. An already sent injection cannot
 * be retracted; cancellation suppresses its late success and all subsequent sends.
 */
export class ScreenObservationTransport {
  private readonly options: ScreenObservationTransportOptions;
  private readonly timeoutMs: number;
  private activeRun: ObservationRun | null = null;
  private stopped = false;

  constructor(options: ScreenObservationTransportOptions) {
    this.options = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.timeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }

  get busy(): boolean {
    return this.activeRun !== null;
  }

  observe(frame: ScreenObservationFrame, signal?: AbortSignal): Promise<ScreenObservationResult> {
    if (this.stopped || signal?.aborted) {
      return Promise.reject(new ScreenObservationCancelledError());
    }
    if (this.activeRun) return Promise.resolve({ status: "busy", capturedAt: frame.capturedAt });
    if (!validFrame(frame)) return Promise.reject(new Error("Invalid screen capture"));
    const threadId = this.options.getThreadId();
    if (!threadId) return Promise.resolve({ status: "busy", capturedAt: frame.capturedAt });

    return new Promise<ScreenObservationResult>((resolve, reject) => {
      const onAbort = () => run.finish(undefined, new ScreenObservationCancelledError());
      const timeout = globalThis.setTimeout(() => {
        run.finish(undefined, new Error("Screen sharing timed out"));
      }, this.timeoutMs);
      const run: ObservationRun = {
        frame,
        threadId,
        settled: false,
        finish: (result, error) => {
          if (run.settled) return;
          run.settled = true;
          globalThis.clearTimeout(timeout);
          signal?.removeEventListener("abort", onAbort);
          if (error) reject(error);
          else if (result) resolve(result);
        },
      };
      this.activeRun = run;
      signal?.addEventListener("abort", onAbort, { once: true });
      void this.perform(run);
    });
  }

  /** Cancels pending delivery, keeping the transport reusable after its RPC settles. */
  cancel(): void {
    this.activeRun?.finish(undefined, new ScreenObservationCancelledError());
  }

  /** Permanently disables delivery for this connection owner. */
  stop(): void {
    this.stopped = true;
    this.cancel();
  }

  private assertCurrent(run: ObservationRun): void {
    if (
      run.settled ||
      this.stopped ||
      this.activeRun !== run ||
      this.options.getThreadId() !== run.threadId
    ) {
      throw new ScreenObservationCancelledError();
    }
  }

  private async perform(run: ObservationRun): Promise<void> {
    try {
      this.assertCurrent(run);
      await this.options.request("thread/inject_items", {
        threadId: run.threadId,
        items: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: screenCapturePrompt(run.frame) },
              { type: "input_image", image_url: run.frame.imageDataUrl, detail: "auto" },
            ],
          },
        ],
      });
      this.assertCurrent(run);
      run.finish({ status: "shared", capturedAt: run.frame.capturedAt });
    } catch (error) {
      // RPC errors can contain request bodies. Never propagate image/context content
      // to the calling UI's error messages or diagnostics.
      run.finish(
        undefined,
        error instanceof ScreenObservationCancelledError
          ? error
          : new Error("Could not share the screen with the main agent"),
      );
    } finally {
      if (this.activeRun === run) this.activeRun = null;
    }
  }
}
