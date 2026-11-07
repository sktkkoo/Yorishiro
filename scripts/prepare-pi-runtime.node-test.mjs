import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  assertNodeArchitecture,
  distribution,
  extractNodeArchive,
  hostTarget,
  PI_VERSION,
  parseArguments,
  preparedRuntime,
  prepareRuntime,
  resourceInventory,
  stageVerifiedRuntime,
  validateArchiveNames,
} from "./prepare-pi-runtime.mjs";

const dependencies = Object.fromEntries(
  ["chord", "pi-ai", "pi-durable", "pi-schema"].map((name) => [
    `@earendil-works/${name}`,
    PI_VERSION,
  ]),
);
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "yorishiro pi package "));
  const worker = join(root, "runtime/pi-worker");
  mkdirSync(worker, { recursive: true });
  writeFileSync(
    join(worker, "package.json"),
    JSON.stringify({ name: "fixture-worker", type: "module", files: ["main.mjs"], dependencies }),
  );
  writeFileSync(join(worker, "package-lock.json"), '{"lockfileVersion":3}');
  writeFileSync(join(worker, "main.mjs"), "export const fixture = true;\n");
  writeFileSync(join(worker, "private-auth.json"), "SHOULD_NOT_BUNDLE");
  return { root, worker, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}
function binary(target) {
  const artifact = distribution(target);
  const value = Buffer.alloc(64);
  if (artifact.platform === "darwin") {
    value.writeUInt32LE(0xfeedfacf);
    value.writeUInt32LE(artifact.arch === "arm64" ? 0x100000c : 0x1000007, 4);
  } else {
    Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(value);
    value.writeUInt16LE(artifact.arch === "arm64" ? 183 : 62, 18);
  }
  return value;
}
function install(stage) {
  for (const [name, version] of Object.entries(dependencies)) {
    const path = join(stage, "node_modules", name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, "package.json"), JSON.stringify({ name, version }));
    writeFileSync(join(path, "index.mjs"), "export default {};\n");
  }
}
const target = "aarch64-apple-darwin";
const payload = () => ({ node: binary(target), license: Buffer.from("Fixture Node license\n") });

test("target selection uses explicit Tauri target for cross-builds and rejects unsupported hosts", () => {
  assert.equal(hostTarget("darwin", "arm64"), target);
  assert.equal(hostTarget("linux", "x64"), "x86_64-unknown-linux-gnu");
  assert.equal(
    parseArguments([], { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" }).target,
    "x86_64-apple-darwin",
  );
  assert.equal(
    parseArguments(["--target", target], { TAURI_ENV_TARGET_TRIPLE: "x86_64-apple-darwin" }).target,
    target,
  );
  assert.throws(() => distribution("aarch64-pc-windows-msvc"));
  assert.throws(() => parseArguments(["--unknown"]));
});

test("archive extraction accepts only rooted names and extracts node/license to stdout", () => {
  const artifact = distribution(target);
  const names = [
    `${artifact.prefix}/`,
    `${artifact.prefix}/bin/`,
    `${artifact.prefix}/bin/node`,
    `${artifact.prefix}/LICENSE`,
  ];
  const calls = [];
  const result = extractNodeArchive("archive with spaces.tar.gz", artifact, (program, args) => {
    calls.push([program, ...args]);
    if (args[0] === "-tzf") return Buffer.from(names.join("\n"));
    return args.at(-1).endsWith("LICENSE") ? Buffer.from("license") : binary(target);
  });
  assert.equal(result.node.length, 64);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((call) => !call.includes("-C")));
  for (const invalid of [
    "../evil",
    `${artifact.prefix}/../evil`,
    "/tmp/evil",
    `${artifact.prefix}/bin\\evil`,
  ])
    assert.throws(() => validateArchiveNames([...names, invalid], artifact.prefix));
  assert.throws(() =>
    validateArchiveNames([...names, `${artifact.prefix}/bin/node`], artifact.prefix),
  );
});

test("binary architecture is checked for each supported target", () => {
  for (const selected of [
    target,
    "x86_64-apple-darwin",
    "x86_64-unknown-linux-gnu",
    "aarch64-unknown-linux-gnu",
  ])
    assert.doesNotThrow(() => assertNodeArchitecture(binary(selected), distribution(selected)));
  assert.throws(() => assertNodeArchitecture(binary("x86_64-apple-darwin"), distribution(target)));
});

test("stage is self-contained in a different home/path with spaces and excludes unlisted secrets", () => {
  const f = fixture();
  try {
    stageVerifiedRuntime({
      root: f.root,
      target,
      payload: payload(),
      installDependencies: install,
    });
    assert.equal(preparedRuntime(f.root, target), true);
    const stage = join(f.root, "src-tauri/resources/pi-worker");
    const manifest = JSON.parse(readFileSync(join(stage, "manifest.json")));
    assert.equal(manifest.nodeVersion, "22.23.4");
    assert.equal(manifest.piVersion, "1.5.0");
    assert.ok(manifest.files["node_modules/@earendil-works/pi-ai/package.json"]);
    assert.ok(manifest.files["licenses/Node-LICENSE.txt"]);
    assert.ok(!manifest.files["private-auth.json"]);
    assert.ok(!JSON.stringify(manifest).includes(f.root));
    assert.ok(!JSON.stringify(manifest).includes("SHOULD_NOT_BUNDLE"));
  } finally {
    f.cleanup();
  }
});

test("prepared cache rejects changed sidecar, source and dependency files", () => {
  const f = fixture();
  try {
    const build = () =>
      stageVerifiedRuntime({
        root: f.root,
        target,
        payload: payload(),
        installDependencies: install,
      });
    build();
    const dependency = join(
      f.root,
      "src-tauri/resources/pi-worker/node_modules/@earendil-works/pi-ai/index.mjs",
    );
    writeFileSync(dependency, "changed");
    assert.equal(preparedRuntime(f.root, target), false);
    build();
    writeFileSync(join(f.worker, "main.mjs"), "new source");
    assert.equal(preparedRuntime(f.root, target), false);
    build();
    writeFileSync(join(f.root, "src-tauri/binaries", `yorishiro-pi-node-${target}`), "tampered");
    assert.equal(preparedRuntime(f.root, target), false);
  } finally {
    f.cleanup();
  }
});

test("a complete valid cache is offline and preparation does not invoke installers", async () => {
  const f = fixture();
  try {
    stageVerifiedRuntime({
      root: f.root,
      target,
      payload: payload(),
      installDependencies: install,
    });
    const result = await prepareRuntime({
      root: f.root,
      target,
      fetchArchive: () => {
        throw Error("network must not run");
      },
      installDependencies: () => {
        throw Error("installer must not run");
      },
    });
    assert.equal(result.cached, true);
  } finally {
    f.cleanup();
  }
});

test("checksum failures fail closed before writing a runtime or invoking an installer", async () => {
  const f = fixture();
  try {
    const cache = join(f.root, "cache");
    await assert.rejects(
      prepareRuntime({
        root: f.root,
        target,
        cache,
        fetchArchive: async () => Buffer.from("not the official archive"),
        installDependencies: () => {
          throw Error("must not install");
        },
      }),
      /checksum mismatch/,
    );
    mkdirSync(cache, { recursive: true });
    writeFileSync(join(cache, distribution(target).filename), "corrupted cache");
    await assert.rejects(
      prepareRuntime({
        root: f.root,
        target,
        cache,
        fetchArchive: () => {
          throw Error("must not fetch");
        },
      }),
      /checksum mismatch/,
    );
    assert.deepEqual(readdirSync(join(f.root, "runtime")), ["pi-worker"]);
  } finally {
    f.cleanup();
  }
});

test("failed production install preserves the prior complete runtime", () => {
  const f = fixture();
  try {
    stageVerifiedRuntime({
      root: f.root,
      target,
      payload: payload(),
      installDependencies: install,
    });
    const path = join(f.root, "src-tauri/resources/pi-worker/manifest.json");
    const original = readFileSync(path);
    assert.throws(() =>
      stageVerifiedRuntime({
        root: f.root,
        target,
        payload: payload(),
        installDependencies: () => {
          throw Error("fixture install failed");
        },
      }),
    );
    assert.deepEqual(readFileSync(path), original);
    assert.equal(preparedRuntime(f.root, target), true);
    assert.throws(() => {
      symlinkSync("main.mjs", join(f.root, "src-tauri/resources/pi-worker/link"));
      resourceInventory(join(f.root, "src-tauri/resources/pi-worker"));
    });
  } finally {
    f.cleanup();
  }
});

test("CLI resolves its own entry through a symlink instead of silently exiting", () => {
  const folder = mkdtempSync(join(tmpdir(), "yorishiro prepare alias "));
  try {
    const alias = join(folder, "prepare runtime.mjs");
    symlinkSync(fileURLToPath(new URL("./prepare-pi-runtime.mjs", import.meta.url)), alias);
    const result = spawnSync(process.execPath, [alias, "--target", "unsupported-target"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unsupported Pi runtime target/);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
