import assert from "node:assert/strict";
import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
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

const here = dirname(fileURLToPath(import.meta.url));
await mkdir(join(here, "artifacts"), { recursive: true });
const context = BACKGROUND_CONTEXT;

async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("Fixture observation exceeded 3 seconds")), 3000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function effects(path) {
  try {
    return (await readFile(path, "utf8")).trim().split("\n").filter(Boolean).length;
  } catch (error) {
    if (error.code === "ENOENT") return 0;
    throw error;
  }
}

for (const policy of [undefined, "continue"]) {
  test(`failed run with ${policy ?? "default keep"} policy preserves or advances queued work`, {
    timeout: 10000,
  }, async (t) => {
    const scratch = await mkdtemp(join(here, "artifacts", "failed-run-"));
    const effectPath = join(scratch, "effects.jsonl");
    const storagePath = join(scratch, "session.sqlite");
    const ownerPath = join(scratch, "owner-lock.sqlite");
    let allowFailure;
    let enteredFailure;
    const failureGate = new Promise((resolve) => {
      allowFailure = resolve;
    });
    const entered = new Promise((resolve) => {
      enteredFailure = resolve;
    });
    const faux = fauxProvider();
    faux.setResponses([
      async () => {
        enteredFailure();
        await failureGate;
        return fauxAssistantMessage([], {
          stopReason: "error",
          errorMessage: "503 Service unavailable (deterministic fixture)",
        });
      },
      fauxAssistantMessage([fauxToolCall("queued_effect", {}, { id: "queued-effect" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("Independent queued work completed (deterministic fixture)."),
    ]);
    const models = createModels();
    models.setProvider(faux.provider);
    const registry = createRegistry();
    registry.install(
      defineExtension({
        name: "failure-continuation-fixture",
        tools: [
          defineTool({
            name: "queued_effect",
            description: "Append the independent queued fixture effect once",
            parameters: obj({}),
            replay: "unsafe",
            execute: async () => {
              const file = openSync(effectPath, "a");
              try {
                appendFileSync(file, "queued-effect\n");
                fsyncSync(file);
              } finally {
                closeSync(file);
              }
              return { output: [{ type: "text", text: "Fixture effect recorded" }] };
            },
          }),
        ],
      }),
    );
    const settings = { retry: { maxRetries: 0 }, ...(policy ? { afterFailedRun: policy } : {}) };
    let owner = acquireOwnerLock(ownerPath);
    let harness;
    let firstResult;
    let secondResult;
    let secondId;
    try {
      harness = await Harness.open(
        await openNodeSqliteStorage(storagePath),
        {
          models,
          registry,
          settings,
        },
        context,
      );
      const root = await harness.root(context, {
        agent: { model: { provider: "faux", modelId: "faux-1" } },
      });
      const first = await root.submit(
        {
          type: "input",
          content: "Fixture request that will fail",
          requestId: "failed-fixture",
        },
        context,
      );
      await bounded(entered);
      const second = await root.submit(
        {
          type: "input",
          content: "Independent queued fixture",
          requestId: "queued-fixture",
          whenBusy: "followUp",
        },
        context,
      );
      secondId = second.id;
      assert.equal((await second.status(context)).status, "queued");
      allowFailure();
      firstResult = await bounded(first.wait(context));
      assert.equal(firstResult.status, "unanswered");
      assert.equal(firstResult.reason, "model_error");
      await bounded(harness.waitForIdle(context));
      secondResult = await second.status(context);
      assert.equal(secondResult.status, policy === "continue" ? "done" : "queued");
      assert.equal(faux.state.callCount, policy === "continue" ? 3 : 1);
      assert.equal(await effects(effectPath), policy === "continue" ? 1 : 0);
    } finally {
      allowFailure();
      try {
        await harness?.close(context);
      } finally {
        owner.release();
      }
    }

    // Reopen the actual SQLite storage. Inspection must not start the saved queue.
    const callsBeforeReopen = faux.state.callCount;
    owner = acquireOwnerLock(ownerPath);
    try {
      harness = await Harness.open(
        await openNodeSqliteStorage(storagePath),
        {
          models,
          registry,
          settings,
        },
        context,
      );
      const recovered = await harness.submission(secondId, context);
      assert.ok(recovered);
      const persisted = await recovered.status(context);
      assert.equal(persisted.status, secondResult.status);
      assert.equal(faux.state.callCount, callsBeforeReopen);
      assert.equal(await effects(effectPath), policy === "continue" ? 1 : 0);
      await writeFile(
        join(scratch, "evidence.json"),
        JSON.stringify(
          {
            fixture: true,
            model: "deterministic faux (no provider network)",
            policy: policy ?? "default keep",
            retry: settings.retry,
            firstResult,
            secondResult,
            secondId,
            persisted,
            modelCalls: faux.state.callCount,
            effects: await effects(effectPath),
          },
          null,
          2,
        ),
      );
    } finally {
      try {
        await harness?.close(context);
      } finally {
        owner.release();
      }
    }
    t.diagnostic(`Retained actual Pi/SQLite queued-failure evidence: ${scratch}`);
  });
}
