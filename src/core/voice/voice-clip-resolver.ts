/**
 * Shared voice clip resolver.
 *
 * `voice:<stem>` points at bundled-packs/shared/voices/** and resolves to a
 * Vite asset URL when the optional binary assets are present locally.
 */

const SHARED_VOICES_PREFIX = "/bundled-packs/shared/voices/";
const SUPPORTED_EXT = /\.(mp3|wav|ogg|m4a)$/i;
const VOICE_SCHEME = "voice:";

const SHARED_VOICES_GLOB = import.meta.glob("/bundled-packs/shared/voices/**/*.{mp3,wav,ogg,m4a}", {
  eager: true,
  query: "?url",
  import: "default",
}) as Record<string, string>;

export const SHARED_VOICES: ReadonlyMap<string, string> = buildSharedVoiceMap(SHARED_VOICES_GLOB);

export interface SharedVoiceMapOptions {
  readonly warn?: (message: string) => void;
}

export function pathToVoiceStem(path: string): string {
  const stripped = path.startsWith(SHARED_VOICES_PREFIX)
    ? path.slice(SHARED_VOICES_PREFIX.length)
    : path;
  return stripped.replace(SUPPORTED_EXT, "");
}

export function buildSharedVoiceMap(
  glob: Record<string, string>,
  options: SharedVoiceMapOptions = {},
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const sources = new Map<string, string>();
  const warn = options.warn ?? console.warn;
  for (const [path, url] of Object.entries(glob)) {
    const stem = pathToVoiceStem(path);
    const parts = stem.split("/");
    const basenameStem = parts[parts.length - 1] ?? stem;
    for (const key of new Set([stem, basenameStem])) {
      const existingPath = sources.get(key);
      if (existingPath !== undefined) {
        warn(
          `Duplicate shared voice name '${key}': '${path}' collides with '${existingPath}'. ` +
            "Skipping this alias.",
        );
        continue;
      }
      sources.set(key, path);
      map.set(key, url);
    }
  }
  return map;
}

export function resolveSharedVoice(
  stem: string,
  sharedMap: ReadonlyMap<string, string> = SHARED_VOICES,
): string | null {
  return sharedMap.get(stem) ?? null;
}

export function resolveSharedVoiceRef(
  clipRef: string,
  sharedMap: ReadonlyMap<string, string> = SHARED_VOICES,
): string | null {
  if (!clipRef.startsWith(VOICE_SCHEME)) return null;
  return resolveSharedVoice(clipRef.slice(VOICE_SCHEME.length), sharedMap);
}

export function isPlayableVoiceUrl(clipRef: string): boolean {
  return /^(https?|asset|blob):/i.test(clipRef);
}
