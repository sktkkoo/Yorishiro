/**
 * Mouse attention producer。
 *
 * document level の click を listen し、target 要素が interactive
 * (`<button>` / `<a>` / `[role="button"]` / `<input>` / `<select>` /
 * `<textarea>` / `<label>`) なら要素 rect を、それ以外は click 座標
 * ± 10px を `mouse` kind で emit。
 *
 * 失効は resolver の maxAge=800ms に任せる (timer 不要)。dispose で
 * listener を外す。
 */

import type { AttentionRuntime } from "../attention-runtime/types";
import type { Disposable } from "./types";

const PRIORITY = 4;
const CONFIDENCE = 1;
const HALO_RADIUS_PX = 10;

const INTERACTIVE_TAGS = new Set(["BUTTON", "A", "INPUT", "SELECT", "TEXTAREA", "LABEL"]);

interface StartOptions {
  readonly attention: AttentionRuntime;
}

export function startMouseAttentionProducer(opts: StartOptions): Disposable {
  const { attention } = opts;

  const onClick = (event: MouseEvent): void => {
    const rect = computeRect(event);
    attention.setSourceTarget("mouse", {
      kind: "mouse",
      source: "mouse",
      rect,
      confidence: CONFIDENCE,
      priority: PRIORITY,
      timestamp: performance.now(),
    });
  };

  document.addEventListener("click", onClick, true);

  return {
    dispose: () => {
      document.removeEventListener("click", onClick, true);
    },
  };
}

function computeRect(event: MouseEvent): { x: number; y: number; width: number; height: number } {
  const target = event.target;
  if (target instanceof Element) {
    if (INTERACTIVE_TAGS.has(target.tagName) || target.getAttribute("role") === "button") {
      const r = target.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
    }
  }
  return {
    x: event.clientX - HALO_RADIUS_PX,
    y: event.clientY - HALO_RADIUS_PX,
    width: HALO_RADIUS_PX * 2,
    height: HALO_RADIUS_PX * 2,
  };
}
