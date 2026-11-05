import { openConfiguredModels, parseOptions, StartupError } from "./config.mjs";
import { runWorker } from "./protocol.mjs";

try {
  const options = parseOptions(process.argv.slice(2));
  const configured = await openConfiguredModels(options);
  // runWorker invokes closeModels only after Harness.close has completed.
  await runWorker(options, {
    models: configured.models,
    closeModels: configured.close,
    fixture: false,
  });
} catch (error) {
  // Provider/tool exception messages can contain input or credential material.
  // Report fixed categories rather than dumping arbitrary exception details.
  const code =
    error instanceof StartupError
      ? error.code
      : error?.code === "storage_owned"
        ? "storage_owned"
        : "storage_unavailable";
  process.stdout.write(`${JSON.stringify({ type: "startup_error", code })}\n`);
  process.exitCode = code === "storage_owned" ? 3 : 2;
}
