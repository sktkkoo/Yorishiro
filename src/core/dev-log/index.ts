/**
 * DevLog primitive barrel.
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「ログという細い回路（生成期の sibling）」+
 *             docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「自己生成 loop」
 */

export {
  createSubsystemLog,
  DevLog,
  type DevLogDeps,
  type DevLogEntry,
  type DevLogQueryFilter,
  type DevLogWriteInput,
  type SubsystemLog,
} from "./dev-log";
