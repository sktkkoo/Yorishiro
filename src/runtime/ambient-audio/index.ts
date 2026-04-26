/**
 * AmbientAudioRuntime barrel — runtime ambient audio subsystem の public API。
 *
 * Internal design-record: specs/2026-04-25-scene-ambient-audio-design.md
 */

export { AmbientAudioRuntime, type ResolvedSound } from "./ambient-audio";
export { type InitResult, initAmbientAudio } from "./wire";
