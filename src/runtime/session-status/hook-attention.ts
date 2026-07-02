import type { SessionAttention } from "./session-status-store";

export interface HookAttentionSignal {
  readonly title: string;
  readonly body: string;
  readonly source: Extract<SessionAttention["source"], "hook">;
  readonly sessionId: string | null;
}

/**
 * hook server から届いた signal JSON を、tab の入力待ち badge に使える
 * attention request へ変換する。
 *
 * PermissionRequest は明示的な承認待ちとして扱う。Notification は agent によって
 * 汎用通知にも使われるため、入力/承認待ちを示す文言がある場合だけ採用する。
 */
export function parseHookAttentionSignal(sig: string): HookAttentionSignal | null {
  const obj = parseSignalObject(sig);
  if (obj === null) return null;
  if (obj.event !== "notification" && obj.event !== "permission-request") return null;

  const message = typeof obj.message === "string" ? obj.message.trim() : "";
  const rawToolName =
    typeof obj.tool_name === "string"
      ? obj.tool_name
      : typeof obj.toolName === "string"
        ? obj.toolName
        : "";
  const toolName = rawToolName.trim();

  if (obj.event === "notification" && !isAttentionNotificationMessage(message)) {
    return null;
  }

  const agent = typeof obj.agent === "string" ? obj.agent.trim() : "";
  const title = agent === "codex" ? "Codex" : "Claude Code";
  const fallback =
    obj.event === "permission-request"
      ? toolName.length > 0
        ? `Permission requested for ${toolName}`
        : "Permission requested"
      : message;

  return {
    title,
    body: message.length > 0 ? message : fallback,
    source: "hook",
    sessionId: parseHookTargetSessionIdFromObject(obj),
  };
}

/**
 * hook signal が「agent はもう許可待ちではない」を意味するか。
 *
 * `pre-tool-use` は approve 後に tool 実行へ進んだ境界なので、長い command 中も
 * 承認待ち badge を残さないために解除 signal として扱う。
 */
export function isAttentionResolvingSignal(sig: string): boolean {
  const obj = parseSignalObject(sig);
  if (obj === null) return false;
  return (
    obj.event === "stop" ||
    obj.event === "prompt" ||
    obj.event === "pre-tool-use" ||
    obj.event === "post-tool-use" ||
    obj.event === "post-tool-failure" ||
    obj.event === "permission-denied" ||
    obj.event === "stop-failure"
  );
}

/** Rust hook server が付与する seq。immediate event と polling fallback の dedup に使う。 */
export function hookSignalSeq(sig: string): number | null {
  const obj = parseSignalObject(sig);
  if (obj === null) return null;
  const seq = obj._charminal_seq;
  return typeof seq === "number" && Number.isFinite(seq) ? seq : null;
}

export function parseHookTargetSessionId(sig: string): string | null {
  const obj = parseSignalObject(sig);
  return obj === null ? null : parseHookTargetSessionIdFromObject(obj);
}

function parseSignalObject(sig: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(sig);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
}

function parseHookTargetSessionIdFromObject(obj: Record<string, unknown>): string | null {
  const sessionId = obj.sessionId;
  return typeof sessionId === "string" && sessionId.trim().length > 0 ? sessionId.trim() : null;
}

export function isAttentionNotificationMessage(message: string): boolean {
  if (message.length === 0) return false;
  return (
    /\b(?:permission|approval|input|confirmation)\b.{0,80}\b(?:required|requested|needed|waiting)\b/i.test(
      message,
    ) ||
    /\b(?:approve|allow|confirm|continue|proceed)\b.{0,80}\?/i.test(message) ||
    /(?:入力待ち|入力が必要|承認待ち|承認が必要|許可待ち|許可が必要|確認が必要)/.test(message)
  );
}

export function isOscAttentionNotificationMessage(message: string): boolean {
  if (isAttentionNotificationMessage(message)) return true;
  if (message.length === 0) return false;
  return (
    /\b(?:agent|claude|codex)\b.{0,80}\bwaiting for (?:your )?input\b/i.test(message) ||
    /\bneeds input\b/i.test(message) ||
    /\brequires approval\b/i.test(message)
  );
}
