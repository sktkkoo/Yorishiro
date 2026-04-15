/**
 * @charminal/runtime
 *
 * Runtime services: Trigger dispatch（EventBus）、Pack 管理（PersonaRegistry）、
 * motion collision 解決（BodyScheduler）。HMR-aware singleton store は
 * `./hot-data` から直接 import する（barrel 経由では出さない — 土台で
 * あって service ではない、という意図を明示するため）。
 *
 * 詳細は `docs/design-record/2026-04-11-design-exploration.md` Section 4.3。
 */

export { BodyScheduler } from "./body-scheduler";
export { EventBus } from "./event-bus";
export { PersonaRegistry } from "./persona-registry";
