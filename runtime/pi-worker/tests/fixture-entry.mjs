// Test-only injector. It is not shipped by the production package's files list.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import { runWorker } from "../protocol.mjs";

const args = process.argv.slice(2);
const nativeFixture = args[0] === "--fixture" && args.length === 2;
const [cwd, sessionDir, policyText, scenario = "read"] = nativeFixture
  ? [process.cwd(), args[1], readFileSync(join(process.cwd(), "fixture-policy.json"), "utf8")]
  : args;
const permissions = JSON.parse(policyText);
const barrierPhase = scenario.startsWith("before-admission-")
  ? "before"
  : scenario.startsWith("after-admission-")
    ? "after"
    : null;
const modelScenario = scenario.replace(/^(before|after)-admission-/, "");
const faux = fauxProvider();
const report = JSON.stringify({
  reply: "fixture only",
  replyKind: "report",
  observedReply: null,
  understandings: [],
  drafts: [],
  reflection: "",
  nextStep: null,
});
faux.setResponses(
  Array.from({ length: 30 }, () => (request) => {
    const latestInput = request.messages.findLastIndex((message) => message.role === "user");
    const results = request.messages
      .slice(latestInput + 1)
      .filter((message) => message.role === "toolResult");
    if (modelScenario === "create") {
      const calls = [
        ["write_file", { path: "result.txt", content: "one" }],
        ["edit_file", { path: "result.txt", oldText: "one", newText: "two" }],
        ["run_command", { commandId: "verify" }],
      ];
      const call = calls[results.length];
      return call
        ? fauxAssistantMessage(
            [fauxToolCall(call[0], call[1], { id: `fixture-${results.length}` })],
            { stopReason: "toolUse" },
          )
        : fauxAssistantMessage(report);
    }
    return results.length
      ? fauxAssistantMessage(report)
      : fauxAssistantMessage(
          [fauxToolCall("read_file", { path: "input.txt" }, { id: "fixture-read" })],
          { stopReason: "toolUse" },
        );
  }),
);
const models = createModels();
models.setProvider(faux.provider);
const pauseAdmission = async (phase) => {
  if (barrierPhase !== phase) return;
  await new Promise((resolve, reject) =>
    process.stdout.write(`${JSON.stringify({ type: "fixture_barrier", phase })}\n`, (error) =>
      error ? reject(error) : resolve(),
    ),
  );
  await new Promise(() => {});
};
try {
  await runWorker(
    { cwd, sessionDir, permissions, provider: "faux", model: "faux-1" },
    {
      models,
      fixture: true,
      modelCalls: () => faux.state.callCount,
      beforeAdmission: () => pauseAdmission("before"),
      afterAdmission: () => pauseAdmission("after"),
    },
  );
} catch (error) {
  process.stdout.write(
    `${JSON.stringify({ type: "startup_error", code: error?.code === "storage_owned" ? "storage_owned" : "fixture_startup_failed" })}\n`,
  );
  process.exitCode = error?.code === "storage_owned" ? 3 : 2;
}
