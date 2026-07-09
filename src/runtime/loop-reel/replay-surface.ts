import { getSurfaceRegistry, TERMINAL_SURFACE_FALLBACK_SELECTOR } from "../surface-registry";

export function resolveReplayTerminalSurface(doc: Document = document): HTMLElement | null {
  const registeredTerminal = getSurfaceRegistry().get("terminal");
  if (registeredTerminal?.isConnected === true && isVisibleSurface(registeredTerminal)) {
    return registeredTerminal;
  }

  const visibleXterm = [...doc.querySelectorAll<HTMLElement>(".xterm-singleton-container")].find(
    isVisibleSurface,
  );
  if (visibleXterm) return visibleXterm;

  const [activeSelector, fallbackSelector] = TERMINAL_SURFACE_FALLBACK_SELECTOR.split(",").map(
    (selector) => selector.trim(),
  );
  return (
    doc.querySelector<HTMLElement>(activeSelector) ??
    doc.querySelector<HTMLElement>(fallbackSelector)
  );
}

function isVisibleSurface(el: HTMLElement): boolean {
  const style = getComputedStyle(el);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
