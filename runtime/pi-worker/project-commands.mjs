import { spawn } from "node:child_process";
import { constants } from "node:fs";
import {
  access,
  copyFile,
  link,
  lstat,
  mkdtemp,
  open,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

export const PROJECT_COMMAND_IDS = Object.freeze([
  "project-check",
  "project-test",
  "project-build",
]);
export const COMMAND_PRESET_IDS = Object.freeze([
  "workspace-info",
  "validate-json",
  "git-status",
  "git-diff",
  ...PROJECT_COMMAND_IDS,
]);
export const PROJECT_TIMEOUT_MS = 300_000;
const checker = fileURLToPath(new URL("./workspace-check.mjs", import.meta.url));

export async function verifiedProjectCommandIds(permissions) {
  const verified = new Set();
  const node = await realpath(process.execPath);
  const helper = await realpath(checker);
  for (const command of permissions?.commands ?? []) {
    try {
      if (
        PROJECT_COMMAND_IDS.includes(command.id) &&
        command.timeoutMs === PROJECT_TIMEOUT_MS &&
        command.args?.length === 2 &&
        command.args[1] === command.id &&
        (await realpath(command.program)) === node &&
        (await realpath(command.args[0])) === helper
      )
        verified.add(command.id);
    } catch {
      /* 同名の既存の独自コマンドを、検証済みのプロジェクト実行とは扱わない。 */
    }
  }
  return verified;
}

async function manifest(path) {
  if (!(await lstat(path)).isFile()) throw new Error("Project manifest must be a regular file.");
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const data = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(data, 0, data.length, 0);
    if (bytesRead > 1024 * 1024) throw new Error("Project manifest exceeds its size limit.");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(data.subarray(0, bytesRead)),
    );
  } finally {
    await handle.close();
  }
}

export async function projectCapabilities(cwd) {
  try {
    const value = await manifest(join(cwd, "package.json"));
    const scripts = value.scripts && typeof value.scripts === "object" ? value.scripts : {};
    const has = (key) => typeof scripts[key] === "string" && scripts[key].trim().length > 0;
    const check = ["check", "typecheck", "lint"].find(has) ?? null;
    const test = ["test:run", "test:ci", "test"].find(has) ?? null;
    const build = has("build") ? "build" : null;
    const vitest = test === "test" && /\bvitest\b/.test(scripts.test);
    return {
      kind: "npm",
      scripts: { check, test, build },
      vitest,
      availableCommands: [
        check && "project-check",
        test && "project-test",
        build && "project-build",
      ].filter(Boolean),
    };
  } catch (error) {
    if (error.code !== "ENOENT")
      throw new Error(
        "Cannot read package.json. Fix the selected project's manifest before running project commands.",
      );
  }
  try {
    if (!(await lstat(join(cwd, "Cargo.toml"))).isFile()) throw new Error("invalid");
    return { kind: "cargo", availableCommands: [...PROJECT_COMMAND_IDS] };
  } catch (error) {
    if (error.code !== "ENOENT") throw new Error("Cargo.toml must be a regular project manifest.");
  }
  return { kind: "none", availableCommands: [] };
}

async function executable(name) {
  for (const folder of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const suffix of process.platform === "win32" ? [".exe", ""] : [""]) {
      const path = join(folder, name + suffix);
      try {
        if (!(await lstat(await realpath(path))).isFile()) continue;
        await access(path, constants.X_OK);
        return await realpath(path);
      } catch {
        /* 明示された PATH の次の候補を調べる。 */
      }
    }
  }
  throw new Error(
    `${name} is unavailable. Install ${name === "cargo" ? "Rust/Cargo" : "Git"} and make it available on the application PATH, then retry.`,
  );
}

async function npmCli() {
  for (const folder of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    for (const path of [join(folder, "npm"), join(folder, "node_modules/npm/bin/npm-cli.js")]) {
      try {
        const actual = await realpath(path);
        if (
          (await lstat(actual)).isFile() &&
          (actual.endsWith("npm-cli.js") || path.endsWith("/npm"))
        )
          return actual;
      } catch {
        /* npm は任意導入のため、未導入時は対応方法を返す。 */
      }
    }
  }
  throw new Error(
    "npm is unavailable. Install npm and make it available on the application PATH, then retry.",
  );
}

function run(program, args, cwd, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "inherit", "inherit"],
    });
    const signals = ["SIGTERM", "SIGINT", "SIGHUP"];
    const handlers = signals.map((signal) => () => child.kill(signal));
    signals.forEach((signal, index) => {
      process.once(signal, handlers[index]);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), PROJECT_TIMEOUT_MS);
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      signals.forEach((name, index) => {
        process.removeListener(name, handlers[index]);
      });
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Project command failed (${code ?? signal}). Review its output and fix the project before retrying.`,
          ),
        );
    });
  });
}

/** 引数は固定。npm スクリプトは利用者が許可したプロジェクトのコードで、
 * ファイルを生成する場合がある。既存のプロセスグループと出力上限、中断処理で
 * ヘルパーと子プロセスをまとめて制限する。 */
export async function runDevelopmentCommand(action, cwd) {
  const env = {
    PATH: process.env.PATH ?? "",
    LANG: "C.UTF-8",
    HOME: homedir(),
    CI: "true",
    CARGO_INCREMENTAL: "0",
    ...(PROJECT_COMMAND_IDS.includes(action) && process.env.CARGO_TARGET_DIR
      ? { CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR }
      : {}),
    npm_config_update_notifier: "false",
    npm_config_audit: "false",
    npm_config_fund: "false",
  };
  if (action === "git-status" || action === "git-diff") {
    const git = await executable("git");
    const fixed = [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=",
      "-c",
      "core.untrackedCache=false",
    ];
    if (action === "git-status")
      await run(
        git,
        [
          ...fixed,
          "status",
          "--short",
          "--branch",
          "--untracked-files=normal",
          "--ignore-submodules=all",
          "--",
          ".",
        ],
        cwd,
        env,
      );
    else {
      for (const staged of [false, true]) {
        process.stdout.write(staged ? "Staged changes:\n" : "Unstaged changes:\n");
        await run(
          git,
          [
            ...fixed,
            "diff",
            ...(staged ? ["--cached"] : []),
            "--no-ext-diff",
            "--no-textconv",
            "--ignore-submodules=all",
            "--",
            ".",
          ],
          cwd,
          env,
        );
      }
    }
    return;
  }
  if (!PROJECT_COMMAND_IDS.includes(action)) throw new Error("workspace_check_invalid");
  const project = await projectCapabilities(cwd);
  if (!project.availableCommands.includes(action))
    throw new Error(
      `No ${action} script is declared in the selected folder. Add a supported package.json script or select a Cargo project, then retry.`,
    );
  const step = action.slice("project-".length);
  if (project.kind === "cargo") return run(await executable("cargo"), [step], cwd, env);
  const npm = await npmCli();
  const shim = await mkdtemp(join(tmpdir(), "yorishiro-project-node-"));
  try {
    const node = join(shim, process.platform === "win32" ? "node.exe" : "node");
    if (process.platform === "win32") {
      try {
        await link(process.execPath, node);
      } catch {
        await copyFile(process.execPath, node);
      }
    } else await symlink(process.execPath, node);
    const args = [
      npm,
      "run",
      project.scripts[step],
      ...(project.vitest && step === "test" ? ["--", "--run"] : []),
    ];
    await run(process.execPath, args, cwd, {
      ...env,
      PATH: shim + delimiter + env.PATH,
      NODE: process.execPath,
    });
  } finally {
    await rm(shim, { recursive: true, force: true });
  }
}
