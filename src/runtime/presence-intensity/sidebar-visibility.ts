export const SIDEBAR_WIDTH_CSS_VAR = "--sidebar-width";
export const SIDEBAR_BORDER_WIDTH_CSS_VAR = "--sidebar-border-width";

const DEFAULT_SIDEBAR_WIDTH = 280;
const OPEN_BORDER_WIDTH = "1px";
const CLOSED_BORDER_WIDTH = "0px";

export function readPresenceSidebarWidth(
  root: HTMLElement,
  fallback = DEFAULT_SIDEBAR_WIDTH,
): number {
  const raw = getComputedStyle(root).getPropertyValue(SIDEBAR_WIDTH_CSS_VAR).trim();
  const n = Number.parseFloat(raw);
  return Number.isNaN(n) ? fallback : n;
}

export function writePresenceSidebarWidth(
  root: HTMLElement,
  surface: HTMLElement,
  px: number,
): void {
  root.style.setProperty(SIDEBAR_WIDTH_CSS_VAR, `${px}px`);
  root.style.setProperty(
    SIDEBAR_BORDER_WIDTH_CSS_VAR,
    px <= 0 ? CLOSED_BORDER_WIDTH : OPEN_BORDER_WIDTH,
  );
  surface.classList.toggle("presence-closed", px <= 0);
}

export function syncPresenceClosedStyles(
  root: HTMLElement,
  shell: HTMLElement | null,
  closed: boolean,
): void {
  if (closed) root.style.setProperty(SIDEBAR_WIDTH_CSS_VAR, "0px");
  root.style.setProperty(
    SIDEBAR_BORDER_WIDTH_CSS_VAR,
    closed ? CLOSED_BORDER_WIDTH : OPEN_BORDER_WIDTH,
  );
  shell?.classList.toggle("presence-closed", closed);
}
