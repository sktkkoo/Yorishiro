import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { isDeepStrictEqual } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createRegistry, defineDoc, defineExtension, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assertAdmission, openAdmissionEpoch } from "./admission-identity.mjs";
import { acquireOwnerLock } from "./owner-lock.mjs";
import { describeSubmissionTools } from "./submission-evidence.mjs";
import { createWorkspaceTools, validatePermissions } from "./workspace-tools.mjs";

const MAX_FRAME = 1024 * 1024;
const REQUEST_DIGEST_ALGORITHM = "sha256-json-envelope-v1";
const RequestIdentities = defineDoc({
  kind: "yorishiro.request-identities",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ requests: {} }),
  checkpointWhen: () => true,
});
const hash = (text) => createHash("sha256").update(text, "utf8").digest("hex");

function requestIdentity(record) {
  const supplied = record.requestPayload !== undefined;
  const payload = supplied
    ? record.requestPayload
    : JSON.stringify({ message: record.message, outputSchema: record.outputSchema ?? null });
  if (typeof payload !== "string") throw new Error("request_payload_invalid");
  let parsed;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("request_payload_invalid");
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 2 ||
    !Object.hasOwn(parsed, "message") ||
    !Object.hasOwn(parsed, "outputSchema") ||
    typeof parsed.message !== "string" ||
    !parsed.message.trim() ||
    (parsed.outputSchema !== null &&
      (typeof parsed.outputSchema !== "object" || Array.isArray(parsed.outputSchema)))
  )
    throw new Error("request_payload_invalid");
  if (
    (record.message !== undefined && record.message !== parsed.message) ||
    (record.outputSchema !== undefined &&
      !isDeepStrictEqual(record.outputSchema, parsed.outputSchema))
  )
    throw new Error("request_payload_mismatch");
  const digest = hash(payload);
  if (record.requestDigest !== undefined && record.requestDigest !== digest)
    throw new Error("request_digest_mismatch");
  return { key: hash(record.requestId), digest, envelope: parsed };
}
// If close fails while the process is still alive, retain its lease. A new
// worker must not acquire storage while that failed owner may still run work.
const failedCloseOwners = new Set();

function storeIdentity(sessionDir, identity) {
  const path = join(sessionDir, "worker-identity.json");
  if (existsSync(path)) {
    let existing;
    try {
      existing = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw new Error("storage_identity_invalid");
    }
    const normalized = {
      ...existing,
      authMode: Object.hasOwn(existing, "authMode") ? existing.authMode : "apiKey",
      authPath: Object.hasOwn(existing, "authPath") ? existing.authPath : null,
    };
    if (JSON.stringify(normalized) !== JSON.stringify(identity))
      throw new Error("storage_identity_mismatch");
    return;
  }
  if (existsSync(join(sessionDir, "session.sqlite"))) throw new Error("storage_identity_missing");
  const temporary = join(sessionDir, `.identity-${randomUUID()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(identity)}\n`, { flag: "wx", mode: 0o600 });
  const file = openSync(temporary, "r");
  try {
    fsyncSync(file);
  } finally {
    closeSync(file);
  }
  renameSync(temporary, path);
  const directory = openSync(sessionDir, "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}

/** Generic runtime for isolated tests and the production entry. Only the test
 * entry injects faux models and fixture:true; main has no such configuration. */
export async function runWorker(options, dependencies) {
  const { models, fixture = false, input = process.stdin, output = process.stdout } = dependencies;
  const context = BACKGROUND_CONTEXT;
  const permissions = validatePermissions(options.permissions);
  const cwd = realpathSync(options.cwd);
  if (!models.getModel(options.provider, options.model)) throw new Error("model_unavailable");
  mkdirSync(options.sessionDir, { recursive: true, mode: 0o700 });
  const sessionDir = realpathSync(options.sessionDir);
  const owner = acquireOwnerLock(join(sessionDir, "owner-lock.sqlite"));
  let harness;
  let closing = false;
  let closePromise;
  let writes = Promise.resolve();
  const waiting = new Map();
  function emit(value) {
    const text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > MAX_FRAME) return Promise.reject(new Error("response_too_large"));
    writes = writes.then(
      () =>
        new Promise((resolve, reject) => {
          output.write(text, (error) => (error ? reject(error) : resolve()));
        }),
    );
    return writes;
  }
  const close = () => {
    if (!closePromise) {
      closing = true;
      closePromise = harness ? harness.close(context) : Promise.resolve();
    }
    return closePromise;
  };
  const signal = () => {
    void close()
      .finally(() => input.destroy?.())
      .catch(() => {});
  };
  process.once("SIGTERM", signal);
  process.once("SIGHUP", signal);
  try {
    storeIdentity(sessionDir, {
      provider: options.provider,
      model: options.model,
      cwd,
      permissions,
      fixture,
      authMode: options.authMode ?? "apiKey",
      authPath: options.authPath ?? null,
    });
    const sessionPath = join(sessionDir, "session.sqlite");
    const epoch = openAdmissionEpoch(sessionPath);
    const registry = createRegistry();
    const tools = await createWorkspaceTools(cwd, permissions, {
      sessionDir,
      protectedPaths: options.authPath ? [join(options.authPath, "..")] : [],
    });
    registry.install(defineExtension({ name: "workspace", tools }));
    harness = await Harness.open(
      await openNodeSqliteStorage(sessionPath),
      {
        models,
        registry,
        settings: {
          afterFailedRun: "continue",
          retry: { maxRetries: 2 },
          toolExecution: "sequential",
        },
      },
      context,
    );
    const root = await harness.root(context, {
      agent: { model: { provider: options.provider, modelId: options.model }, cwd, maxTurns: 32 },
    });
    const admission = Object.freeze({ version: 1, epoch, rootId: root.id });

    async function identityOf(record) {
      if (!record?.requestId) return undefined;
      const ledger = await harness.snapshot(RequestIdentities, root.id, context);
      const identity = ledger?.requests[hash(record.requestId)];
      return identity?.requestId === record.requestId && identity.submissionId === record.id
        ? identity
        : undefined;
    }

    async function describe(id, requestedId) {
      const submission = id === undefined ? undefined : await harness.submission(id, context);
      if (id !== undefined && !submission) throw new Error("submission_unknown");
      const record = submission ? await submission.status(context) : undefined;
      const identity = await identityOf(record);
      let report = null;
      if (record?.type === "input" && record.status === "done") {
        const page = await root.entries(
          { minEntryId: record.answer, maxEntryId: record.answer },
          1,
          undefined,
          context,
        );
        const text = page.items
          .flatMap((entry) => entry.model ?? [])
          .filter((message) => message.role === "assistant")
          .flatMap((message) => message.content ?? [])
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("");
        try {
          const parsed = JSON.parse(text);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) report = parsed;
        } catch {
          /* Host retires an unreadable report. */
        }
      }
      return {
        found: Boolean(record),
        requestId: record?.requestId ?? requestedId ?? null,
        requestDigest: identity?.digest ?? null,
        submissionId: record?.id ?? null,
        status: record?.status ?? null,
        reason: record?.status === "unanswered" ? record.reason : undefined,
        report,
        ...(await describeSubmissionTools(root, record, context)),
        ...(fixture && dependencies.modelCalls ? { modelCalls: dependencies.modelCalls() } : {}),
      };
    }
    async function select(record) {
      if (record.requestId !== undefined) {
        if (typeof record.requestId !== "string" || !record.requestId)
          throw new Error("request_invalid");
        const saved = await root.commit(
          (tx) => tx.submissionByRequest(root.id, record.requestId),
          context,
        );
        if (record.submissionId !== undefined && (!saved || saved.id !== record.submissionId))
          throw new Error("submission_mismatch");
        if (
          saved &&
          record.requestDigest !== undefined &&
          (await identityOf(saved))?.digest !== record.requestDigest
        )
          throw new Error("request_digest_mismatch");
        return saved?.id;
      }
      if (
        record.submissionId !== undefined &&
        (!Number.isSafeInteger(record.submissionId) || record.submissionId <= 0)
      )
        throw new Error("submission_invalid");
      return record.submissionId;
    }
    function watch(submission) {
      if (waiting.has(submission.id)) return;
      const promise = submission
        .wait(context)
        .then(async () => {
          if (!closing) await emit({ type: "settled", ...(await describe(submission.id)) });
        })
        .catch(async () => {
          if (!closing)
            await emit({
              type: "run_error",
              submissionId: submission.id,
              code: "observation_failed",
            });
        })
        .finally(() => waiting.delete(submission.id));
      waiting.set(submission.id, promise);
      // Broken stdout is a transport failure, not an unhandled provider error.
      void promise.catch(() => {});
    }
    async function command(record) {
      if (typeof record?.id !== "string" || !record.id || typeof record.type !== "string") {
        await emit({ type: "response", id: null, success: false, error: "command_invalid" });
        return;
      }
      const response = (data) =>
        emit({ type: "response", id: record.id, command: record.type, success: true, data });
      try {
        switch (record.type) {
          case "submit": {
            if (record.admission !== undefined) assertAdmission(record.admission, admission);
            if (typeof record.requestId !== "string" || !record.requestId)
              throw new Error("request_invalid");
            const identity = requestIdentity(record);
            let message = identity.envelope.message;
            const outputSchema = identity.envelope.outputSchema;
            if (outputSchema !== null) {
              if (!outputSchema || typeof outputSchema !== "object" || Array.isArray(outputSchema))
                throw new Error("schema_invalid");
              message += `\nReturn the final answer as one JSON object conforming to this report schema. Tool execution belongs in tools, not in claims of completed work.\n${JSON.stringify(outputSchema)}`;
            }
            if (fixture) await dependencies.beforeAdmission?.(record);
            const submissionId = await root.commit(async (tx) => {
              const ledger = await tx.doc(RequestIdentities, root.id);
              const saved = await tx.submissionByRequest(root.id, record.requestId);
              const prior = ledger.requests[identity.key];
              if (saved) {
                if (
                  !prior ||
                  prior.requestId !== record.requestId ||
                  prior.submissionId !== saved.id ||
                  prior.digest !== identity.digest
                )
                  throw new Error("request_identity_mismatch");
                return saved.id;
              }
              if (prior) throw new Error("request_identity_without_submission");
              const id = await root.submit(tx, {
                type: "input",
                requestId: record.requestId,
                content: message,
                whenBusy: "followUp",
              });
              ledger.requests[identity.key] = {
                requestId: record.requestId,
                digest: identity.digest,
                submissionId: id,
              };
              return id;
            }, context);
            if (fixture) await dependencies.afterAdmission?.(record, submissionId);
            const submission = await harness.submission(submissionId, context);
            await response({
              disposition: "accepted",
              submissionId: submission.id,
              requestId: record.requestId,
              requestDigest: identity.digest,
              status: (await submission.status(context)).status,
            });
            watch(submission);
            return;
          }
          case "status":
            await response(await describe(await select(record), record.requestId));
            return;
          case "resume": {
            const id = await select(record);
            const submission = id === undefined ? undefined : await harness.submission(id, context);
            if (
              (record.requestId !== undefined || record.submissionId !== undefined) &&
              !submission
            )
              throw new Error("submission_unknown");
            harness.resume();
            await response({ disposition: "resuming" });
            if (submission) watch(submission);
            return;
          }
          case "shutdown":
            await close();
            await response({ disposition: "closed" });
            return;
          default:
            throw new Error("command_unknown");
        }
      } catch (error) {
        await emit({
          type: "response",
          id: record.id,
          command: record.type,
          success: false,
          error: error?.message === "admission_mismatch" ? "admission_mismatch" : "command_failed",
        });
      }
    }
    await emit({
      type: "ready",
      protocol: 2,
      provider: options.provider,
      model: options.model,
      cwd,
      sessionDir,
      permissions,
      fixture,
      authMode: options.authMode ?? "apiKey",
      authPath: options.authPath ?? null,
      conversationId: root.id,
      ownerLock: "sqlite-exclusive",
      admission,
      idempotentSubmit: true,
      requestDigestAlgorithm: REQUEST_DIGEST_ALGORITHM,
    });
    const decoder = new StringDecoder("utf8");
    let buffered = "";
    outer: for await (const chunk of input) {
      buffered += decoder.write(chunk);
      while (true) {
        const end = buffered.indexOf("\n");
        if (end < 0) break;
        const line = buffered.slice(0, end).replace(/\r$/, "");
        buffered = buffered.slice(end + 1);
        if (Buffer.byteLength(line) > MAX_FRAME) throw new Error("frame_too_large");
        if (!line.trim()) continue;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          await emit({ type: "response", id: null, success: false, error: "json_invalid" });
          continue;
        }
        await command(record);
        if (closing) break outer;
      }
      if (Buffer.byteLength(buffered) > MAX_FRAME) throw new Error("frame_too_large");
    }
    if (buffered.length && !closing) throw new Error("frame_incomplete");
  } finally {
    process.removeListener("SIGTERM", signal);
    process.removeListener("SIGHUP", signal);
    let closed = false;
    try {
      await close();
      closed = true;
      await Promise.allSettled([...waiting.values()]);
      await writes;
    } finally {
      if (closed) {
        try {
          await dependencies.closeModels?.();
        } finally {
          owner.release();
        }
      } else failedCloseOwners.add(owner);
    }
  }
}
