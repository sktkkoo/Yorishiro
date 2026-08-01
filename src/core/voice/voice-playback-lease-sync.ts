import type { VoicePlaybackOwnershipState, VoicePlayer } from "./voice-player";

export interface VoicePlaybackLeaseUpdate {
  readonly ownerId: string;
  readonly generation: number;
  readonly enabled: boolean;
}

export interface VoicePlaybackLeaseTransport {
  readonly registerOwner: () => Promise<string>;
  readonly update: (state: VoicePlaybackLeaseUpdate) => Promise<void>;
}

export class VoicePlaybackLeaseSync {
  private ownerPromise: Promise<string> | null = null;
  private ownerId: string | null = null;
  private latestUpdateAttempt = 0;

  constructor(
    private readonly player: VoicePlayer,
    private readonly transport: VoicePlaybackLeaseTransport,
  ) {}

  async setEnabled(enabled: boolean): Promise<void> {
    const ownership = this.player.setPlaybackEnabled(enabled);
    const attempt = ++this.latestUpdateAttempt;
    const ownerId = await this.getOwnerId();

    try {
      await this.transport.update({
        ownerId,
        generation: ownership.generation,
        enabled: ownership.fallbackPlaybackEnabled,
      });
    } catch (error) {
      if (this.canInvalidate(ownerId, ownership, attempt)) this.invalidate(ownerId);
      throw error;
    }
  }

  private getOwnerId(): Promise<string> {
    if (this.ownerPromise !== null) return this.ownerPromise;

    const registration = this.transport.registerOwner();
    const pending = registration
      .then((ownerId) => {
        this.ownerId = ownerId;
        this.player.setPlaybackOwnerId(ownerId);
        return ownerId;
      })
      .catch((error) => {
        if (this.ownerPromise === pending) this.ownerPromise = null;
        throw error;
      });
    this.ownerPromise = pending;
    return pending;
  }

  private canInvalidate(
    ownerId: string,
    ownership: VoicePlaybackOwnershipState,
    attempt: number,
  ): boolean {
    return (
      attempt === this.latestUpdateAttempt &&
      ownerId === this.ownerId &&
      ownership.generation === this.player.getPlaybackOwnershipState().generation
    );
  }

  private invalidate(ownerId: string): void {
    this.player.clearPlaybackOwnerId(ownerId);
    this.ownerId = null;
    this.ownerPromise = null;
  }
}
