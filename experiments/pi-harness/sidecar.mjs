// Evaluation seam only. Real providers deliberately remain unimplemented.
import { appendFileSync, closeSync, fsyncSync, openSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  LiveDoc,
} from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import { acquireOwnerLock } from "./owner-lock.mjs";
import { describeSubmissionTools } from "./submission-evidence.mjs";

const args = process.argv.slice(2);
if (
  args[0] !== "--fixture" ||
  !args[1] ||
  args.length > 3 ||
  (args.length === 3 && args[2] !== "--hold-tool")
) {
  process.stderr.write(
    "Unconfigured provider: this evaluation requires explicit --fixture <scratch-directory>.\n",
  );
  process.exit(2);
}
const scratch = realpathSync(args[1]);
const artifactRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "artifacts"));
if (!scratch.startsWith(artifactRoot + sep))
  throw new Error("Scratch must be inside experiment artifacts");
const holdTool = args.includes("--hold-tool");
const context = BACKGROUND_CONTEXT;
// Acquire before opening Pi storage or constructing an active harness.
let owner;
try {
  owner = acquireOwnerLock(join(scratch, "owner-lock.sqlite"));
} catch (error) {
  const code = error.code === "storage_owned" ? "storage_owned" : "storage_unavailable";
  process.stdout.write(`${JSON.stringify({ type: "startup_error", code })}\n`);
  process.stderr.write(`${error.message}\n`);
  process.exit(code === "storage_owned" ? 3 : 4);
}
let writes = Promise.resolve();
function emit(value) {
  // Callback waits until the stream accepts/drains the write. No stdout logs.
  writes = writes.then(
    () =>
      new Promise((resolve, reject) => {
        process.stdout.write(`${JSON.stringify(value)}\n`, (error) =>
          error ? reject(error) : resolve(),
        );
      }),
  );
  return writes;
}
const faux = fauxProvider();
const fixtureReport = JSON.stringify({
  reply: "Deterministic fixture answer; this is not a real-model result.",
  replyKind: "report",
  observedReply: null,
  understandings: [],
  drafts: [],
  reflection: "",
  nextStep: null,
});
const fixtureResponse = (request) =>
  request.messages.some((message) => message.role === "toolResult")
    ? fauxAssistantMessage(fixtureReport)
    : fauxAssistantMessage([fauxToolCall("scratch_effect", {}, { id: "sidecar-effect" })], {
        stopReason: "toolUse",
      });
faux.setResponses(Array.from({ length: 20 }, () => fixtureResponse));
const models = createModels();
models.setProvider(faux.provider);
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "sidecar-fixture",
    tools: [
      defineTool({
        name: "scratch_effect",
        description: "Apply one scratch journal effect",
        parameters: obj({}),
        replay: "unsafe",
        execute: async (_args, api, callContext) => {
          const fd = openSync(join(scratch, "effects.jsonl"), "a");
          try {
            appendFileSync(fd, "scratch effect\n");
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          await api.details({ effectApplied: true }, callContext);
          await emit({ type: "tool_effect", fixture: true });
          if (holdTool)
            await new Promise((_resolve, reject) => {
              const signal = callContext.abortSignal;
              if (signal?.aborted) reject(signal.reason);
              else signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
            });
          return { output: [{ type: "text", text: "Scratch effect applied" }] };
        },
      }),
    ],
  }),
);
const harness = await Harness.open(
  await openNodeSqliteStorage(join(scratch, "session.sqlite")),
  { models, registry },
  context,
);
const root = await harness.root(context, {
  agent: { model: { provider: "faux", modelId: "faux-1" } },
});
const waiting = new Set();
let closing = false;
async function describe(submissionId) {
  const submission = submissionId ? await harness.submission(submissionId, context) : undefined;
  if (submissionId && !submission) throw new Error("Unknown submissionId");
  const record = submission ? await submission.status(context) : undefined;
  let report = null;
  if (record?.type === "input" && record.status === "done") {
    const answer = await root.entries(
      { minEntryId: record.answer, maxEntryId: record.answer },
      1,
      undefined,
      context,
    );
    const text = answer.items
      .flatMap((entry) => entry.model ?? [])
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("");
    try {
      const value = JSON.parse(text);
      if (value && typeof value === "object" && !Array.isArray(value)) report = value;
    } catch {
      /* A completed but unreadable report is not a successful report. */
    }
  }
  return {
    found: Boolean(record),
    requestId: record?.requestId ?? null,
    submissionId,
    status: record?.status ?? null,
    report,
    modelCalls: faux.state.callCount,
    live: await harness.snapshot(LiveDoc, root.id, context),
    ...(await describeSubmissionTools(root, record, context)),
  };
}

async function selectedSubmission(record) {
  if (record.requestId !== undefined) {
    if (typeof record.requestId !== "string" || !record.requestId)
      throw new Error("requestId must be a nonempty string");
    const found = await root.commit(
      (tx) => tx.submissionByRequest(root.id, record.requestId),
      context,
    );
    if (record.submissionId !== undefined && (!found || found.id !== record.submissionId))
      throw new Error("requestId and submissionId do not identify the same submission");
    return found?.id;
  }
  return record.submissionId;
}
function watch(submission, requestId) {
  if (waiting.has(submission.id)) return;
  waiting.add(submission.id);
  void submission
    .wait(context)
    .then(async () => {
      await emit({ type: "settled", requestId, ...(await describe(submission.id)) });
    })
    .catch(async (error) => {
      if (!closing)
        await emit({
          type: "run_error",
          requestId,
          submissionId: submission.id,
          error: error.message,
        });
    })
    .finally(() => waiting.delete(submission.id));
}
async function command(record) {
  if (typeof record?.id !== "string" || !record.id || typeof record.type !== "string") {
    await emit({
      type: "response",
      id: record?.id ?? null,
      success: false,
      error: "id and type required",
    });
    return;
  }
  try {
    let data;
    switch (record.type) {
      case "submit": {
        if (
          typeof record.requestId !== "string" ||
          !record.requestId ||
          typeof record.message !== "string"
        ) {
          throw new Error("submit requires durable requestId and message");
        }
        const submission = await root.submit(
          { type: "input", requestId: record.requestId, content: record.message },
          context,
        );
        data = {
          disposition: "accepted",
          submissionId: submission.id,
          status: (await submission.status(context)).status,
        };
        await emit({ type: "response", id: record.id, command: record.type, success: true, data });
        watch(submission, record.requestId);
        return;
      }
      case "status":
        data = await describe(await selectedSubmission(record));
        break;
      case "resume": {
        const selected = await selectedSubmission(record);
        const submission = selected ? await harness.submission(selected, context) : undefined;
        if ((record.submissionId !== undefined || record.requestId !== undefined) && !submission)
          throw new Error("Unknown submission");
        harness.resume();
        await emit({
          type: "response",
          id: record.id,
          command: record.type,
          success: true,
          data: { disposition: "resuming" },
        });
        if (submission) watch(submission, null);
        return;
      }
      case "shutdown":
        closing = true;
        await harness.close(context);
        await emit({
          type: "response",
          id: record.id,
          command: record.type,
          success: true,
          data: { disposition: "closed" },
        });
        return;
      default:
        throw new Error("Unknown command");
    }
    await emit({ type: "response", id: record.id, command: record.type, success: true, data });
  } catch (error) {
    await emit({
      type: "response",
      id: record.id,
      command: record.type,
      success: false,
      error: error.message,
    });
  }
}
await emit({
  type: "ready",
  protocol: 2,
  fixture: true,
  provider: "faux",
  model: "faux-1",
  sessionDir: scratch,
  cwd: scratch,
  conversationId: root.id,
  ownerLock: "sqlite-exclusive",
});
const decoder = new StringDecoder("utf8");
let buffered = "";
try {
  outer: for await (const chunk of process.stdin) {
    buffered += decoder.write(chunk);
    while (true) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      const line = buffered.slice(0, end).replace(/\r$/, "");
      buffered = buffered.slice(end + 1);
      if (Buffer.byteLength(line) > 1024 * 1024) throw new Error("Record exceeds 1 MiB");
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        await emit({ type: "response", id: null, success: false, error: "Malformed JSON" });
        continue;
      }
      await command(record);
      if (closing) break outer;
    }
    if (Buffer.byteLength(buffered) > 1024 * 1024) throw new Error("Record exceeds 1 MiB");
  }
} finally {
  if (!closing) {
    closing = true;
    await harness.close(context);
  }
  await writes;
  owner.release();
}
