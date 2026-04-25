/**
 * attention-producers — runtime event を AttentionTarget に変換する layer。
 *
 * 各 producer は独立 module で、`start*Producer` 関数が Disposable を返す。
 * App.tsx からは Phase 1d で配線する。
 */

export { startDevAttentionProducer } from "./dev";
export { startInputCursorAttentionProducer } from "./input-cursor";
export { startMcpAttentionProducer } from "./mcp";
export { startMouseAttentionProducer } from "./mouse";
export { startTerminalAttentionProducer } from "./terminal";
export { startToolAttentionProducer } from "./tool";
