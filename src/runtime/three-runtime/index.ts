/**
 * @charminal/runtime/three-runtime
 *
 * Webview-lifetime singleton holding canvas + WebGLRenderer + Scene + Camera
 * + RAF loop + current VRM + current Body. Internal design-record:
 * 2026-04-17-three-runtime-singleton.md.
 */

export { getThreeRuntime } from "./three-runtime";
export type { ThreeRuntime } from "./types";
