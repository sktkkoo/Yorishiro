/**
 * @yorishiro/runtime
 *
 * Runtime services: Trigger dispatch（EventBus）、persona 管理
 * （PersonaRegistryImpl + PersonaReflexDispatcher の 2 primitive）、
 * motion collision 解決（BodyScheduler）、Module Registry（ModuleRegistry）。
 * HMR-aware singleton store は `./hot-data` から直接 import する（barrel 経由
 * では出さない — 土台であって service ではない、という意図を明示するため）。
 * ModuleRegistry も同様に `./module-registry` から直接 import する（hotData
 * と並ぶ foundational layer）。
 *
 * 詳細は internal design-record: `2026-04-11-design-exploration.md` Section 4.3、
 * persona の責務分離は `2026-04-19-persona-registry-unification.md`。
 */

export { BodyScheduler } from "./body-scheduler";
export { EventBus } from "./event-bus";
export { PersonaReflexDispatcher } from "./persona-reflex";
export { PersonaRegistryImpl } from "./persona-registry";
