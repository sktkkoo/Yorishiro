// init.js 変更を window title suffix で可視化するための純粋ヘルパ。
export const INIT_CHANGED_MARKER = " — init.js changed (⌘R)";

export function appendInitChangedMarker(title: string): string {
  if (title.endsWith(INIT_CHANGED_MARKER)) return title;
  return `${title}${INIT_CHANGED_MARKER}`;
}

export function stripInitChangedMarker(title: string): string {
  if (!title.endsWith(INIT_CHANGED_MARKER)) return title;
  return title.slice(0, -INIT_CHANGED_MARKER.length);
}
