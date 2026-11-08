// A submission's status must never borrow another input's tool observations.
const inspectionCommands = new Set(["workspace-info", "validate-json", "git-status", "git-diff"]);
const projectCommands = new Set(["project-check", "project-test", "project-build"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exactKeys = (value, allowed) => Object.keys(value).every((key) => allowed.includes(key));

function classifyCall(call, verifiedProjects) {
  const args = call.arguments;
  if (!object(args)) return { effect: "unknown", commandId: null };
  if (
    call.name === "write_file" &&
    exactKeys(args, ["path", "content", "expectedContent"]) &&
    typeof args.path === "string" &&
    args.path.length > 0 &&
    typeof args.content === "string" &&
    args.content !== args.expectedContent &&
    (args.expectedContent === undefined || typeof args.expectedContent === "string")
  )
    return { effect: "write", commandId: null };
  if (
    call.name === "edit_file" &&
    exactKeys(args, ["path", "oldText", "newText"]) &&
    typeof args.path === "string" &&
    args.path.length > 0 &&
    typeof args.oldText === "string" &&
    typeof args.newText === "string" &&
    args.oldText !== args.newText
  )
    return { effect: "write", commandId: null };
  if (["read_file", "read_continuity_context", "read_command_output"].includes(call.name))
    return { effect: "read", commandId: null };
  if (
    call.name === "run_command" &&
    exactKeys(args, ["commandId"]) &&
    typeof args.commandId === "string" &&
    args.commandId
  ) {
    const commandId = args.commandId;
    return {
      commandId,
      effect:
        projectCommands.has(commandId) && verifiedProjects.has(commandId)
          ? "project-check"
          : inspectionCommands.has(commandId)
            ? "read"
            : "unknown",
    };
  }
  return { effect: "unknown", commandId: null };
}

export async function describeSubmissionTools(root, record, context, options = {}) {
  if (
    record?.type !== "input" ||
    record.status !== "done" ||
    !Number.isSafeInteger(record.entry) ||
    record.entry <= 0 ||
    !Number.isSafeInteger(record.answer) ||
    record.entry > record.answer
  ) {
    return { toolResults: [], toolEvidenceComplete: false, toolEvidenceRange: null };
  }
  const query = { minEntryId: record.entry, maxEntryId: record.answer, order: "ascending" };
  const calls = new Map();
  const results = [];
  let cursor;
  let complete = true;
  let previousEntry = record.entry - 1;
  const seenCursors = new Set();
  do {
    const page = await root.entries(query, 100, cursor, context);
    for (const entry of page.items) {
      if (
        !Number.isSafeInteger(entry.id) ||
        entry.id <= previousEntry ||
        entry.id < record.entry ||
        entry.id > record.answer
      ) {
        complete = false;
        continue;
      }
      previousEntry = entry.id;
      for (const message of entry.model ?? []) {
        if (entry.kind === "pi.assistant" && message.role === "assistant") {
          for (const part of Array.isArray(message.content) ? message.content : []) {
            if (part.type !== "toolCall" || typeof part.id !== "string" || !part.id) continue;
            const matching = calls.get(part.id) ?? [];
            matching.push({ entryId: entry.id, name: part.name, arguments: part.arguments });
            calls.set(part.id, matching);
          }
        }
        if (entry.kind === "pi.tool-result" && message.role === "toolResult")
          results.push({ entryId: entry.id, message });
      }
    }
    cursor = page.next;
    if (cursor !== undefined) {
      const key = JSON.stringify(cursor);
      if (seenCursors.has(key)) {
        complete = false;
        break;
      }
      seenCursors.add(key);
    }
  } while (cursor !== undefined);
  // Only the host's verified fixed-helper policy may identify project commands.
  // Neither model arguments nor result.details can grant those semantics.
  const verifiedProjects =
    options.verifiedProjectCommandIds instanceof Set
      ? options.verifiedProjectCommandIds
      : new Set();
  const toolResults = results.map(({ entryId, message }) => {
    const matching = calls.get(message.toolCallId) ?? [];
    const call =
      matching.length === 1 &&
      matching[0].entryId < entryId &&
      typeof message.toolName === "string" &&
      matching[0].name === message.toolName
        ? matching[0]
        : null;
    return {
      entryId,
      toolCallId: message.toolCallId,
      isError: message.isError,
      interrupted: JSON.stringify(message).includes("was interrupted"),
      progressEvidenceVersion: 1,
      callEntryId: call?.entryId ?? null,
      toolName: call?.name ?? null,
      ...(call ? classifyCall(call, verifiedProjects) : { commandId: null, effect: "unknown" }),
    };
  });
  return {
    toolResults,
    toolEvidenceComplete: complete,
    toolEvidenceRange: { firstEntryId: record.entry, lastEntryId: record.answer },
  };
}
