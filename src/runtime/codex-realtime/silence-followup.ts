import type { SilenceFollowupSettings } from "./silence-followup-settings";
import type { ConversationPart, FollowupCandidate } from "./temporary-followup";

/** 有効な接続にだけ作る。履歴は当該音声会話の完了済み発話だけ、停止時に全破棄する。 */
export class SilenceFollowup {
  private parts: ConversationPart[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private generation: AbortController | null = null;
  private epoch = 0;
  private eligible = false;
  private userSpeaking = false;
  private responseActive = false;
  private protocolResponse = false;
  private playback = false;
  private disposed = false;
  private lastActivity = Date.now();
  constructor(
    private readonly settings: SilenceFollowupSettings,
    private readonly allowed: () => boolean,
    private readonly generate: (
      parts: readonly ConversationPart[],
      signal: AbortSignal,
    ) => Promise<FollowupCandidate>,
    private readonly speak: (text: string) => Promise<void>,
    private readonly cooldown = { lastAttempt: -Infinity },
  ) {}

  private invalidate(): void {
    this.epoch++;
    this.generation?.abort();
    this.generation = null;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.lastActivity = Date.now();
  }
  userStarted(): void {
    this.invalidate();
    this.userSpeaking = true;
    this.eligible = false;
  }
  userStopped(): void {
    this.userSpeaking = false;
    this.lastActivity = Date.now();
    this.schedule();
  }
  responseStarted(protocol = false): void {
    this.invalidate();
    this.responseActive = true;
    this.protocolResponse ||= protocol;
  }
  responseStopped(): void {
    this.responseActive = false;
    this.protocolResponse = false;
    this.lastActivity = Date.now();
    this.schedule();
  }
  observePlayback(active: boolean): void {
    if (active === this.playback) return;
    this.playback = active;
    this.invalidate();
    if (!active) this.schedule();
  }
  record(role: unknown, value: unknown): void {
    if (this.disposed || !this.settings.enabled || !this.allowed()) return;
    if ((role !== "user" && role !== "assistant") || typeof value !== "string" || !value.trim())
      return;
    this.invalidate();
    // 長い発話を途中で切って判断しない。今回の声かけは見送り、次の発話を待つ。
    if (value.length > 4000) {
      this.parts = [];
      this.eligible = false;
      return;
    }
    this.parts.push({ role, text: value });
    while (this.parts.length > 12 || JSON.stringify(this.parts).length > 16_000) this.parts.shift();
    if (role === "user") {
      this.eligible = true;
      this.userSpeaking = false;
    }
    if (role === "assistant" && !this.protocolResponse) this.responseActive = false;
    this.schedule();
  }
  private schedule(): void {
    if (
      this.disposed ||
      !this.settings.enabled ||
      !this.eligible ||
      !this.allowed() ||
      this.userSpeaking ||
      this.responseActive ||
      this.playback ||
      this.generation ||
      this.timer !== null
    )
      return;
    const wait =
      Math.max(
        this.lastActivity + this.settings.silenceSeconds * 1000,
        this.cooldown.lastAttempt + this.settings.cooldownSeconds * 1000,
      ) - Date.now();
    this.timer = setTimeout(
      () => {
        this.timer = null;
        void this.run();
      },
      Math.max(0, wait),
    );
  }
  private async run(): Promise<void> {
    if (
      this.disposed ||
      !this.allowed() ||
      !this.eligible ||
      this.userSpeaking ||
      this.responseActive ||
      this.playback
    )
      return;
    // 失敗や speak=false でも同じユーザー発話から繰り返し推論しない。
    this.eligible = false;
    this.cooldown.lastAttempt = Date.now();
    const epoch = this.epoch;
    const controller = new AbortController();
    this.generation = controller;
    try {
      const candidate = await this.generate([...this.parts], controller.signal);
      if (
        !controller.signal.aborted &&
        !this.disposed &&
        epoch === this.epoch &&
        this.allowed() &&
        !this.userSpeaking &&
        !this.responseActive &&
        !this.playback &&
        candidate.speak
      ) {
        await this.speak(candidate.text);
      }
    } catch {
      /* 任意の声かけの失敗は通常会話に波及させず、自動再送もしない。 */
    } finally {
      if (this.generation === controller) this.generation = null;
      this.schedule();
    }
  }
  dispose(): void {
    this.disposed = true;
    this.invalidate();
    this.parts = [];
    this.eligible = false;
  }
}
