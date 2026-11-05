// A submission's status must never borrow another input's tool observations.
export async function describeSubmissionTools(root, record, context) {
  if (
    record?.type !== "input" ||
    record.status !== "done" ||
    !Number.isSafeInteger(record.entry) ||
    !Number.isSafeInteger(record.answer) ||
    record.entry > record.answer
  ) {
    return { toolResults: [], toolEvidenceComplete: false, toolEvidenceRange: null };
  }
  const query = {
    minEntryId: record.entry,
    maxEntryId: record.answer,
    order: "ascending",
  };
  const toolResults = [];
  let cursor;
  do {
    const page = await root.entries(query, 100, cursor, context);
    for (const entry of page.items) {
      if (entry.kind !== "pi.tool-result") continue;
      for (const message of entry.model ?? []) {
        if (message.role !== "toolResult") continue;
        toolResults.push({
          entryId: entry.id,
          toolCallId: message.toolCallId,
          isError: message.isError,
          interrupted: JSON.stringify(message).includes("was interrupted"),
        });
      }
    }
    cursor = page.next;
  } while (cursor !== undefined);
  return {
    toolResults,
    toolEvidenceComplete: true,
    toolEvidenceRange: { firstEntryId: record.entry, lastEntryId: record.answer },
  };
}
