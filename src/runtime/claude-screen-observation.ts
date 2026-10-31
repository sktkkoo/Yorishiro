import { invoke } from "@tauri-apps/api/core";
import {
  ScreenObservationCancelledError,
  type ScreenObservationFrame,
  type ScreenObservationResult,
} from "./codex-realtime/screen-observation";
import { screenCapturePrompt } from "./codex-realtime/screen-sharing-prompts";
import { getAnnotationDocument } from "./codex-realtime/use-screen-sharing";

export interface ClaudeScreenOwner {
  readonly sessionId: string;
  readonly conversationId: string;
  readonly revision: number;
}

export interface ClaudeScreenDependencies {
  readonly document: () => Promise<string>;
  readonly begin: (owner: ClaudeScreenOwner & { documentId: string }) => Promise<string>;
  readonly publish: (
    leaseId: string,
    frame: ScreenObservationFrame & { prompt: string },
  ) => Promise<void>;
  readonly end: (leaseId: string) => Promise<void>;
}

const nativeDependencies: ClaudeScreenDependencies = {
  document: getAnnotationDocument,
  begin: (owner) => invoke("claude_screen_sharing_begin", { ...owner }),
  publish: (leaseId, frame) => invoke("claude_screen_sharing_publish", { leaseId, frame }),
  end: (leaseId) => invoke("claude_screen_sharing_end", { leaseId }),
};

// 旧 Start の native 応答と失効処理が終わってから、次の Start を登録する。
let registrationQueue: Promise<unknown> = Promise.resolve();

interface SharingRegistration {
  readonly signal: AbortSignal;
  readonly ready: Promise<string>;
  readonly abort: () => void;
  leaseId: string | null;
}

/** 明示共有の最新画像をメモリに公開する。Claude の推論や端末入力は開始しない。 */
export class ClaudeScreenObservationTransport {
  private registration: SharingRegistration | null = null;
  private stopped = false;
  private busy = false;

  constructor(
    private readonly owner: ClaudeScreenOwner,
    private readonly deps: ClaudeScreenDependencies = nativeDependencies,
  ) {}

  async observe(
    frame: ScreenObservationFrame,
    signal: AbortSignal,
  ): Promise<ScreenObservationResult> {
    if (this.stopped || signal.aborted) throw new ScreenObservationCancelledError();
    if (this.busy) return { status: "busy", capturedAt: frame.capturedAt };
    this.busy = true;
    try {
      const registration = this.getRegistration(signal);
      const leaseId = await registration.ready;
      this.assertCurrent(registration);
      await this.deps.publish(leaseId, { ...frame, prompt: screenCapturePrompt(frame) });
      this.assertCurrent(registration);
      // shared は参照可能な状態。Claude が画像を取得・理解したという意味ではない。
      return { status: "shared", capturedAt: frame.capturedAt };
    } catch (error) {
      if (error instanceof ScreenObservationCancelledError || signal.aborted || this.stopped) {
        throw new ScreenObservationCancelledError();
      }
      // native のエラー本文に画像や capability が含まれていても UI に出さない。
      this.revoke();
      throw new Error("Could not make the shared image available to Claude Code");
    } finally {
      this.busy = false;
    }
  }

  stop(): void {
    this.stopped = true;
    this.revoke();
  }

  private assertCurrent(registration: SharingRegistration): void {
    if (this.stopped || registration.signal.aborted || this.registration !== registration) {
      throw new ScreenObservationCancelledError();
    }
  }

  private revoke(): void {
    const registration = this.registration;
    this.registration = null;
    if (!registration) return;
    registration.signal.removeEventListener("abort", registration.abort);
    if (registration.leaseId) void this.deps.end(registration.leaseId).catch(() => {});
  }

  private getRegistration(signal: AbortSignal): SharingRegistration {
    if (this.registration?.signal === signal) return this.registration;
    this.revoke();
    const registration: SharingRegistration = {
      signal,
      leaseId: null,
      abort: () => {
        if (this.registration === registration) this.revoke();
      },
      ready: registrationQueue.then(async () => {
        this.assertCurrent(registration);
        const documentId = await this.deps.document();
        this.assertCurrent(registration);
        const leaseId = await this.deps.begin({ ...this.owner, documentId });
        registration.leaseId = leaseId;
        try {
          this.assertCurrent(registration);
        } catch (error) {
          // Abort が begin より先に到着しても、後着した lease を必ず失効させる。
          await this.deps.end(leaseId).catch(() => {});
          throw error;
        }
        return leaseId;
      }),
    };
    registrationQueue = registration.ready.catch(() => {});
    this.registration = registration;
    signal.addEventListener("abort", registration.abort, { once: true });
    return registration;
  }
}
