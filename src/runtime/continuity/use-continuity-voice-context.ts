import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useEffect } from "react";
import { voiceContinuityPrompt } from "../../core/global-prompt/voice-continuity";
import { continuityIdentity } from "./client";
import type { ContinuitySnapshot } from "./types";

/** Refresh an already-connected voice session without starting audio or a turn. */
export function useContinuityVoiceContext({
  personaId,
  active,
  prepareContext,
  onError,
}: {
  readonly personaId: string | null;
  readonly active: boolean;
  readonly prepareContext: (text: string) => Promise<void>;
  readonly onError: (error: unknown) => void;
}): void {
  useEffect(() => {
    if (!active || !personaId) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    let revision = -1;
    let lastPrompt: string | undefined;
    let initialVoiceIds: ReadonlySet<string> | undefined;
    const accept = (snapshot: ContinuitySnapshot) => {
      if (
        disposed ||
        continuityIdentity(snapshot.personaId) !== continuityIdentity(personaId) ||
        snapshot.revision <= revision
      )
        return;
      revision = snapshot.revision;
      initialVoiceIds ??= new Set(
        snapshot.messages.filter((message) => message.source === "voice").map(({ id }) => id),
      );
      const historicalVoiceIds = initialVoiceIds;
      // Live already heard these utterances. Feeding each new transcript back as
      // remembered conversation creates a second input stream of the same speech.
      // Keep history from before the connection and still deliver workspace text,
      // Main Agent observations, learned understanding and drafts independently
      // of continued background work.
      const prompt = voiceContinuityPrompt({
        ...snapshot,
        messages: snapshot.messages.filter(
          (message) => message.source !== "voice" || historicalVoiceIds.has(message.id),
        ),
      });
      if (prompt === lastPrompt) return;
      lastPrompt = prompt;
      void prepareContext(prompt).catch((error: unknown) => {
        if (!disposed) onError(error);
      });
    };
    void (async () => {
      const stop = await listen<ContinuitySnapshot>("continuity:changed", (event) =>
        accept(event.payload),
      );
      if (disposed) {
        stop();
        return;
      }
      unlisten = stop;
      // Subscribe before reading so a slow initial read cannot hide newer evidence.
      accept(await invoke<ContinuitySnapshot>("continuity_status", { personaId }));
    })().catch((error: unknown) => {
      if (!disposed) onError(error);
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [personaId, active, prepareContext, onError]);
}
