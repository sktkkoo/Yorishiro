import { isAbsolute } from "node:path";
import { authStatus, loginWithPi } from "./auth-login.mjs";

const emit = (record) => process.stdout.write(`${JSON.stringify(record)}\n`);
let mode;
let authPath;
let timeoutSeconds = 600;
try {
  const args = process.argv.slice(2);
  mode = args.shift();
  if (!["--status", "--login"].includes(mode)) throw new Error();
  const seen = new Set();
  while (args.length) {
    const option = args.shift();
    const value = args.shift();
    if (!value || seen.has(option)) throw new Error();
    seen.add(option);
    if (option === "--auth-path") authPath = value;
    else if (option === "--timeout-seconds") timeoutSeconds = Number(value);
    else throw new Error();
  }
  if (
    !authPath ||
    !isAbsolute(authPath) ||
    authPath.includes("\0") ||
    !Number.isSafeInteger(timeoutSeconds) ||
    timeoutSeconds < 1 ||
    timeoutSeconds > 600
  )
    throw new Error();
} catch {
  emit({ type: "auth_error", code: "configuration_invalid" });
  process.exitCode = 2;
}

if (process.exitCode === undefined && mode === "--status") {
  try {
    emit(authStatus(authPath));
  } catch {
    emit({ type: "auth_error", code: "runtime_invalid" });
    process.exitCode = 2;
  }
} else if (process.exitCode === undefined && mode === "--login") {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutSeconds * 1000);
  const cancel = () => controller.abort();
  let input = "";
  const receive = (chunk) => {
    input += chunk.toString("utf8");
    if (Buffer.byteLength(input) > 1024) {
      cancel();
      return;
    }
    const end = input.indexOf("\n");
    if (end >= 0) {
      try {
        const value = JSON.parse(input.slice(0, end));
        if (value?.type === "cancel" && Object.keys(value).length === 1) cancel();
        else cancel();
      } catch {
        cancel();
      }
      input = input.slice(end + 1);
    }
  };
  process.once("SIGTERM", cancel);
  process.once("SIGHUP", cancel);
  process.stdin.on("data", receive);
  process.stdin.once("end", cancel);
  try {
    emit(await loginWithPi({ authPath, signal: controller.signal, emit }));
  } catch {
    emit({
      type: "auth_error",
      code: timedOut
        ? "login_timeout"
        : controller.signal.aborted
          ? "login_cancelled"
          : "login_failed",
    });
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGHUP", cancel);
    process.stdin.removeListener("data", receive);
    process.stdin.removeListener("end", cancel);
    process.stdin.pause();
  }
}
