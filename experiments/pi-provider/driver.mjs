import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { loginWithPi } from "./login.mjs";
import { createPiModels } from "./pi.mjs";
import { PiCredentialStore } from "./store.mjs";

const args = process.argv.slice(2);
const mode = args.shift();
let authPath = join(homedir(), ".yorishiro/continuity/pi/auth.json");
let timeoutSeconds = 300;
while (args.length) {
  const option = args.shift();
  const value = args.shift();
  if (option === "--auth-path" && value) authPath = resolve(value);
  else if (
    option === "--timeout-seconds" &&
    value &&
    Number.isFinite(Number(value)) &&
    Number(value) > 0 &&
    Number(value) <= 600
  )
    timeoutSeconds = Number(value);
  else throw new Error("Usage: --check|--login [--auth-path path] [--timeout-seconds 1..600]");
}
if (!["--check", "--login"].includes(mode)) throw new Error("Explicit --check or --login required");
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
let store;
try {
  store = new PiCredentialStore(authPath);
  const models = await createPiModels(store);
  const model = models.getModel("openai", "gpt-6.1-sol");
  if (mode === "--check") {
    const credential = (await store.list()).find((entry) => entry.providerId === "openai");
    emit({
      type: "readiness",
      provider: "openai",
      model: "gpt-6.1-sol",
      modelInCatalog: !!model,
      authMethods: ["oauth", "api_key"],
      credentialPresent: !!credential,
      credentialType: credential?.type ?? null,
      networkVerified: false,
    });
  } else {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error("Login timed out")),
      timeoutSeconds * 1000,
    );
    let input = "";
    let pending;
    const decoder = new StringDecoder("utf8");
    const onData = (chunk) => {
      input += decoder.write(chunk);
      if (Buffer.byteLength(input) > 64 * 1024)
        controller.abort(new Error("Login input too large"));
      const end = input.indexOf("\n");
      if (end >= 0 && pending) {
        const resolve = pending;
        pending = undefined;
        resolve(input.slice(0, end).replace(/\r$/, ""));
        input = input.slice(end + 1);
      }
    };
    const onEnd = () => controller.abort(new Error("Login input closed"));
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    const interaction = {
      notify(event) {
        if (event.type === "auth_url") emit({ type: "auth_url", url: event.url });
        else if (event.type === "progress") emit({ type: "progress" });
      },
      prompt(prompt) {
        if (prompt.type !== "manual_code") throw new Error("Unsupported login prompt");
        emit({
          type: "manual_code",
          message: "Complete browser sign-in or paste the full callback URL followed by LF",
        });
        return new Promise((resolve, reject) => {
          const signal = prompt.signal ?? controller.signal;
          if (signal.aborted) {
            reject(signal.reason);
            return;
          }
          const abort = () => {
            pending = undefined;
            reject(signal.reason);
          };
          signal.addEventListener("abort", abort, { once: true });
          pending = (value) => {
            signal.removeEventListener("abort", abort);
            resolve(value);
          };
          onData(Buffer.alloc(0));
        });
      },
    };
    try {
      emit({
        type: "login_result",
        ...(await loginWithPi({ models, store, interaction, signal: controller.signal })),
      });
    } catch {
      emit({
        type: "login_failed",
        reason: controller.signal.aborted ? "cancelled_or_timed_out" : "provider_or_storage_error",
      });
      process.exitCode = 1;
    } finally {
      clearTimeout(timer);
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.pause();
    }
  }
} catch {
  emit({ type: "driver_error", reason: "storage_or_configuration_error" });
  process.exitCode = 1;
} finally {
  try {
    await store?.close();
  } catch {
    emit({ type: "driver_error", reason: "storage_close_error" });
    process.exitCode = 1;
  }
}
