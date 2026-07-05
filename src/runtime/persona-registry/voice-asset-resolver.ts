/**
 * Persona pack-local voice asset resolver.
 *
 * Shared refs (`voice:<name>`) are handled by VoicePlayer. This module only
 * resolves local refs such as `./assets/vocal.wav` against the active persona
 * pack so user packs can ship pre-rendered singing WAV files.
 */

import { convertFileSrc } from "@tauri-apps/api/core";
import type { VoiceClipRef } from "@yorishiro/sdk";
import type { PersonaEntry } from "./types";

const BUNDLED_PERSONA_VOICE_ASSETS = import.meta.glob(
  "/bundled-packs/personas/**/*.{mp3,wav,ogg,m4a}",
  { eager: true, query: "?url", import: "default" },
) as Record<string, string>;

export interface PersonaVoiceAssetResolvers {
  readonly resolveBundled: (entry: PersonaEntry, relativePath: string) => string | null;
  readonly resolveUser: (entryPath: string, relativePath: string) => Promise<string>;
}

export function normalizeVoiceAssetPath(src: string): string {
  return src.replace(/\\/g, "/").replace(/^\.\//, "");
}

export function isPackLocalVoiceRef(src: string): boolean {
  return src.startsWith("./") || src.startsWith("assets/");
}

export function isSafeVoiceAssetPath(src: string): boolean {
  const clean = normalizeVoiceAssetPath(src);
  if (clean === "" || clean === "." || clean === "..") return false;
  if (clean.startsWith("/") || clean.startsWith("~")) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(clean)) return false;
  return clean.split("/").every((part) => part !== "" && part !== "." && part !== "..");
}

export function resolveBundledPersonaVoiceAsset(
  entry: PersonaEntry,
  relativePath: string,
  bundledAssets: Record<string, string> = BUNDLED_PERSONA_VOICE_ASSETS,
): string | null {
  if (entry.id.includes("/") || entry.id.includes("..")) return null;
  const clean = normalizeVoiceAssetPath(relativePath);
  if (!isSafeVoiceAssetPath(clean)) return null;
  return bundledAssets[`/bundled-packs/personas/${entry.id}/${clean}`] ?? null;
}

export async function resolveUserPersonaVoiceAsset(
  entryPath: string,
  relativePath: string,
): Promise<string> {
  const clean = normalizeVoiceAssetPath(relativePath);
  if (!isSafeVoiceAssetPath(clean)) {
    throw new Error(`unsafe persona voice asset path: ${relativePath}`);
  }
  const packDir = entryPath.replace(/\/[^/]+$/, "");
  return convertFileSrc(`${packDir}/${clean}`);
}

const DEFAULT_RESOLVERS: PersonaVoiceAssetResolvers = {
  resolveBundled: resolveBundledPersonaVoiceAsset,
  resolveUser: resolveUserPersonaVoiceAsset,
};

export async function resolvePersonaVoiceClip(
  entry: PersonaEntry,
  clipRef: VoiceClipRef,
): Promise<string | null> {
  return resolvePersonaVoiceClipWith(entry, clipRef, DEFAULT_RESOLVERS);
}

export async function resolvePersonaVoiceClipWith(
  entry: PersonaEntry,
  clipRef: VoiceClipRef,
  resolvers: PersonaVoiceAssetResolvers,
): Promise<string | null> {
  if (!isPackLocalVoiceRef(clipRef) || !isSafeVoiceAssetPath(clipRef)) return null;

  if (entry.origin === "bundled") {
    return resolvers.resolveBundled(entry, clipRef);
  }

  if (entry.entryPath === undefined) return null;
  try {
    return await resolvers.resolveUser(entry.entryPath, clipRef);
  } catch (error) {
    console.warn(
      `[voice] Failed to resolve persona voice clip '${clipRef}' for '${entry.id}':`,
      error,
    );
    return null;
  }
}
