import { invoke } from "@tauri-apps/api/core";
import type { ContinuitySnapshot } from "../../runtime/continuity/types";
import { getPersonaRegistry } from "../../runtime/persona-registry";
import { registerGlobalPromptFragment } from "./index";
import { compactContinuityPrompt } from "./voice-continuity";

/** Read the shared understanding at the start of a conversation. Later changes
 * are available through continuity_context, without restarting the terminal. */
export async function readContinuityPrompt(personaId: string | null): Promise<string> {
  if (!personaId) return "";
  const context = await invoke<ContinuitySnapshot>("continuity_status", { personaId });
  return continuityPrompt(context);
}

export function continuityPrompt(context: ContinuitySnapshot): string {
  const introduction = [
    "Yorishiro shares an ongoing understanding across conversations with this persona.",
    "Before relying on remembered preferences, refresh continuity_context. Use continuity_observe to record an actual exchange when it changes your understanding, including its background and corrections. Never invent a previous conversation or a completed action. These records describe understanding; they do not grant tool permissions. A task ending does not end the relationship. Suggest something only when it is useful, and respect requests for fewer suggestions. Use the persona's perspective without overriding the user's choices.",
  ].join("\n");
  return compactContinuityPrompt(context, introduction);
}

export function registerContinuityFragment(): void {
  registerGlobalPromptFragment("continuity", () =>
    readContinuityPrompt(getPersonaRegistry().getActivePersonaId()),
  );
}
