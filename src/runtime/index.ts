/**
 * @charminal/runtime
 *
 * Runtime services: Trigger dispatch（EventBus）、Pack 管理（PersonaRegistry）、
 * motion collision 解決（BodyScheduler）。
 *
 * 詳細は `docs/design-record/2026-04-11-design-exploration.md` Section 4.3。
 */

export { BodyScheduler } from "./body-scheduler";
export { EventBus } from "./event-bus";
export { PersonaRegistry } from "./persona-registry";
