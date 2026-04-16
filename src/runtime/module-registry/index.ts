/**
 * @charminal/runtime/module-registry
 *
 * Typed registry of swappable runtime modules. Used by EventBus, body subsystems,
 * and (post-MVP) UGC pack loaders. HMR-surviving via hot-data.
 */

export { KEYS, type KnownKey } from "./keys";
export {
  type Disposable,
  getModuleRegistry,
  type ModuleOf,
  ModuleRegistry,
  type RegistryEntry,
} from "./module-registry";
export {
  type AllowedKindFor,
  isAllowed,
  type ModuleKind,
  type Provenance,
} from "./provenance";
