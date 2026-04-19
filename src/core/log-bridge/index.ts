/**
 * LogBridge primitive barrel。
 *
 * Philosophy: docs/philosophy/CHARMINAL.md「ログという細い回路」+
 *             docs/philosophy/INHABITED_CHARACTER_INTERFACE.md「ログという橋」
 * SDK surface: src/sdk/context.d.ts の LogAPI / LogEntry / LogFilter（514–542）
 */

export {
  createLogAPI,
  LogBridge,
  type LogBridgeDeps,
  type LogQueryFilter,
  type LogWriteInput,
} from "./log-bridge";
