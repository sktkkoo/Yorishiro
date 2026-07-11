export interface FixedTerminalRect {
  readonly top: number;
  readonly left: number;
  readonly width: number;
  readonly height: number;
}

export function readPaddedFixedRect(container: HTMLElement): FixedTerminalRect {
  const rect = container.getBoundingClientRect();
  const cs = getComputedStyle(container);
  const padLeft = parseFloat(cs.paddingLeft) || 0;
  const padTop = parseFloat(cs.paddingTop) || 0;
  const padRight = parseFloat(cs.paddingRight) || 0;
  const padBottom = parseFloat(cs.paddingBottom) || 0;

  return {
    top: rect.top + padTop,
    left: rect.left + padLeft,
    width: Math.max(0, Math.floor(rect.width - padLeft - padRight)),
    height: Math.max(0, Math.floor(rect.height - padTop - padBottom)),
  };
}

export function applyFixedRect(
  target: HTMLElement,
  rect: FixedTerminalRect,
  hidden: boolean,
): void {
  target.style.top = `${rect.top}px`;
  target.style.left = `${rect.left}px`;
  target.style.width = `${rect.width}px`;
  target.style.height = `${rect.height}px`;
  target.style.visibility = hidden ? "hidden" : "visible";
}
