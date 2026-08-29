const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "textarea",
  "select",
  "summary",
  "[contenteditable='true']",
  "[role='button']",
  "[role='link']",
  "[role='menu']",
  "[role='menuitem']",
  "[role='menuitemradio']",
  "[role='dialog']",
  "[data-no-window-drag]",
].join(",");

export function shouldStartViewModeWindowDrag(
  chromeHidden: boolean,
  button: number,
  target: EventTarget | null,
): boolean {
  if (!chromeHidden || button !== 0 || !(target instanceof Element)) return false;
  return target.closest(INTERACTIVE_SELECTOR) === null;
}

export function shouldRevealViewModeHud(chromeHidden: boolean, button: number): boolean {
  return chromeHidden && button === 2;
}

export function nextViewModeHudVisibility(
  chromeHidden: boolean,
  button: number,
  current: boolean,
): boolean {
  return shouldRevealViewModeHud(chromeHidden, button) ? !current : current;
}
