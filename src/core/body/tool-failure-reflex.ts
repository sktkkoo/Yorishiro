/**
 * Classify tool failures that are meaningful enough to trigger a startle reflex.
 *
 * Hook payloads contain both true failures and control-flow misses such as Grep
 * no-match. Startle is a body-level reflex, so it should be reserved for
 * user-visible failures rather than every non-zero tool outcome.
 */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" ? value : "";
}

function toolResponseText(record: Record<string, unknown>): string {
  const response = asRecord(record.tool_response);
  if (response === null) return "";
  return [stringField(response, "stdout"), stringField(response, "stderr")]
    .filter((part) => part.length > 0)
    .join("\n");
}

function joinedPayloadText(record: Record<string, unknown>): string {
  return [
    stringField(record, "error"),
    stringField(record, "message"),
    stringField(record, "reason"),
    stringField(record, "stderr"),
    toolResponseText(record),
  ]
    .filter((part) => part.length > 0)
    .join("\n");
}

function isSearchMiss(toolName: string, message: string): boolean {
  if (/\b(grep|glob)\b/i.test(toolName)) return true;
  if (!/\bsearch\b/i.test(toolName)) return false;
  return /\b(no matches?|no results?|no files? found|nothing found|0 matches|exit(?:ed)?(?: code)? 1|exit status 1)\b/i.test(
    message,
  );
}

export function shouldTriggerStartleForToolFailure(payload: unknown): boolean {
  const record = asRecord(payload);
  if (record === null) return true;

  const toolName =
    stringField(record, "tool_name") ||
    stringField(record, "toolName") ||
    stringField(record, "tool");
  const message = joinedPayloadText(record);

  return !isSearchMiss(toolName, message);
}
