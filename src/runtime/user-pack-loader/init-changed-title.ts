// init.js hot reload failure を window title suffix で可視化するための純粋ヘルパ。
export const INIT_RELOAD_ERROR_MARKER = " — init.js reload failed";
const LEGACY_INIT_CHANGED_MARKER = " — init.js changed (⌘R)";

export function appendInitReloadErrorMarker(title: string): string {
  const cleanTitle = stripInitReloadErrorMarker(title);
  if (cleanTitle.endsWith(INIT_RELOAD_ERROR_MARKER)) return cleanTitle;
  return `${cleanTitle}${INIT_RELOAD_ERROR_MARKER}`;
}

export function stripInitReloadErrorMarker(title: string): string {
  for (const marker of [INIT_RELOAD_ERROR_MARKER, LEGACY_INIT_CHANGED_MARKER]) {
    if (title.endsWith(marker)) return title.slice(0, -marker.length);
  }
  return title;
}
