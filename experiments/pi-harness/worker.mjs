// Actual pi-durable runtime. The model is intentionally deterministic/fake.
// Only this experiment's scratch directory is touched; no credentials/providers load.
import { appendFileSync, closeSync, fsyncSync, openSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { obj } from "@earendil-works/pi-schema";
import { acquireOwnerLock } from "./owner-lock.mjs";

const [mode, scratch, requestId] = process.argv.slice(2);
if (!["complete", "crash", "recover"].includes(mode) || !isAbsolute(scratch ?? "") || !requestId) {
  throw new Error("Expected complete|crash|recover, absolute scratch directory, request ID");
}
const artifactRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), "artifacts"));
if (!realpathSync(scratch).startsWith(artifactRoot + sep)) {
  throw new Error("Scratch directory must be inside this experiment's artifacts directory");
}
const context = BACKGROUND_CONTEXT;
const owner = acquireOwnerLock(join(scratch, "owner-lock.sqlite"));
const send = (message) => process.send?.(message);
const faux = fauxProvider();
const models = createModels();
models.setProvider(faux.provider);
const call = fauxAssistantMessage([fauxToolCall("scratch_effect", {}, { id: "effect-call-1" })], {
  stopReason: "toolUse",
});
const answer = fauxAssistantMessage(
  "Deterministic fixture completed; this is not a quality assessment.",
);
faux.setResponses(mode === "recover" ? [answer] : [call, answer]);
const registry = createRegistry();
registry.install(
  defineExtension({
    name: "scratch-fixture",
    tools: [
      defineTool({
        name: "scratch_effect",
        description: "Append one effect to this test's scratch journal",
        parameters: obj({}),
        // Deliberately unsafe: an interrupted external effect must not be replayed.
        replay: "unsafe",
        execute: async (_args, api, callContext) => {
          const fd = openSync(join(scratch, "effects.jsonl"), "a");
          try {
            appendFileSync(fd, `${JSON.stringify({ requestId, effect: "scratch append" })}\n`);
            fsyncSync(fd);
          } finally {
            closeSync(fd);
          }
          api.output("Scratch effect applied.\n");
          await api.details({ effectApplied: true }, callContext);
          if (mode === "crash") {
            send({ type: "effect-applied", requestId });
            // Parent uses SIGKILL here: no graceful close or fake recovery path.
            await new Promise(() => {});
          }
          return { output: [{ type: "text", text: "Scratch append completed" }] };
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
try {
  const root = await harness.root(context, {
    agent: { model: { provider: "faux", modelId: "faux-1" } },
  });
  const submission = await root.submit(
    { type: "input", content: "Apply the scratch effect once", requestId },
    context,
  );
  send({ type: "admitted", submissionId: submission.id, requestId });
  harness.resume();
  const settled = await submission.wait(context);
  const page = await root.entries({}, 100, undefined, context);
  const toolResults = page.items
    .filter((entry) => entry.kind === "pi.tool-result")
    .flatMap((entry) => entry.model ?? []);
  send({
    type: "result",
    submissionId: submission.id,
    status: settled.status,
    model: "deterministic faux provider (no network)",
    modelCalls: faux.state.callCount,
    entryKinds: page.items.map((entry) => entry.kind),
    toolResults: toolResults.map((message) => ({
      isError: message.isError,
      content: message.content,
      details: message.details,
    })),
  });
} finally {
  await harness.close(context);
  owner.release();
  process.disconnect?.();
}
