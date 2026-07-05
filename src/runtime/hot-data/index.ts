/**
 * @yorishiro/runtime/hot-data
 *
 * HMR-aware singleton store. Used by runtime modules that must survive Vite
 * module reloads (registries, Three.js singletons, etc.).
 */
export { getOrInit } from "./hot-data";
