import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { macosSignatureErrors } from "./lib/macos-signature-verifier.mjs";
import { verifyPiRuntimeBundle } from "./lib/pi-runtime-bundle-verifier.mjs";
import { stageVerifiedRuntime } from "./prepare-pi-runtime.mjs";

function appFixture() {
  const scratch = mkdtempSync(join(tmpdir(), "yorishiro independent bundle "));
  const project = join(scratch, "developer checkout");
  const worker = join(project, "runtime/pi-worker");
  mkdirSync(worker, { recursive: true });
  const files = [
    "main.mjs",
    "diagnose.mjs",
    "auth-main.mjs",
    "auth-login.mjs",
    "workspace-check.mjs",
  ];
  const dependencies = Object.fromEntries(
    ["pi-ai", "pi-durable", "pi-schema", "chord"].map((name) => [
      `@earendil-works/${name}`,
      "1.5.0",
    ]),
  );
  writeFileSync(
    join(worker, "package.json"),
    JSON.stringify({ name: "fixture", type: "module", files, dependencies }),
  );
  writeFileSync(join(worker, "package-lock.json"), '{"lockfileVersion":3}');
  for (const file of files) writeFileSync(join(worker, file), "export default {};\n");
  const node = Buffer.alloc(64);
  node.writeUInt32LE(0xfeedfacf);
  node.writeUInt32LE(0x100000c, 4);
  stageVerifiedRuntime({
    root: project,
    target: "aarch64-apple-darwin",
    payload: { node, license: Buffer.from("fixturelicense") },
    installDependencies(stage) {
      for (const [name, version] of Object.entries(dependencies)) {
        const path = join(stage, "node_modules", name);
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, "package.json"), JSON.stringify({ name, version }));
      }
    },
  });
  const app = join(scratch, "another user", "Applications", "Yorishiro.app");
  mkdirSync(join(app, "Contents/Resources/resources"), { recursive: true });
  mkdirSync(join(app, "Contents/MacOS"), { recursive: true });
  cpSync(
    join(project, "src-tauri/resources/pi-worker"),
    join(app, "Contents/Resources/resources/pi-worker"),
    { recursive: true },
  );
  copyFileSync(
    join(project, "src-tauri/binaries/yorishiro-pi-node-aarch64-apple-darwin"),
    join(app, "Contents/MacOS/yorishiro-pi-node"),
  );
  chmodSync(join(app, "Contents/MacOS/yorishiro-pi-node"), 0o755);
  rmSync(project, { recursive: true });
  return {
    app,
    worker: join(app, "Contents/Resources/resources/pi-worker"),
    cleanup() {
      rmSync(scratch, { recursive: true, force: true });
    },
  };
}

test("packaged runtime remains self-contained after developer checkout is removed", () => {
  const f = appFixture();
  try {
    const result = verifyPiRuntimeBundle(f.app);
    assert.equal(result.nodeVersion, "22.23.4");
    assert.equal(result.target, "aarch64-apple-darwin");
    assert.ok(result.node.startsWith(f.app));
  } finally {
    f.cleanup();
  }
});
test("release resource verification rejects changed, absent and extra resources", () => {
  for (const mutation of [
    (f) => writeFileSync(join(f.worker, "main.mjs"), "tampered"),
    (f) => rmSync(join(f.worker, "node_modules/@earendil-works/pi-ai/package.json")),
    (f) => writeFileSync(join(f.worker, "unknown-file"), "extra"),
  ]) {
    const f = appFixture();
    try {
      mutation(f);
      assert.throws(() => verifyPiRuntimeBundle(f.app));
    } finally {
      f.cleanup();
    }
  }
});
test("signed Node sidecar may have changed bytes but must retain target architecture", () => {
  const f = appFixture();
  try {
    const path = join(f.app, "Contents/MacOS/yorishiro-pi-node");
    writeFileSync(
      path,
      Buffer.concat([readFileSync(path), Buffer.from("simulatedcode-signature")]),
    );
    assert.doesNotThrow(() => verifyPiRuntimeBundle(f.app));
    const wrong = readFileSync(path);
    wrong.writeUInt32LE(0x1000007, 4);
    writeFileSync(path, wrong);
    assert.throws(() => verifyPiRuntimeBundle(f.app), /architecture/);
  } finally {
    f.cleanup();
  }
});
test("resource manifest rejects absolute and parent-relative identities", () => {
  for (const name of ["/private/secret", "../secret", "node_modules/../../secret"]) {
    const f = appFixture();
    try {
      const path = join(f.worker, "manifest.json");
      const manifest = JSON.parse(readFileSync(path));
      manifest.files[name] = "0".repeat(64);
      writeFileSync(path, JSON.stringify(manifest));
      assert.throws(() => verifyPiRuntimeBundle(f.app), /Unsafe/);
    } finally {
      f.cleanup();
    }
  }
});
test("nested executable signature requires hardened JIT and Developer ID but container owns staple", () => {
  const output =
    "CodeDirectory v=20500 flags=0x10000(runtime)\nAuthority=Developer ID Application: Fixture (TEAM)\nAuthority=Developer ID Certification Authority\nAuthority=Apple Root CA\nTeamIdentifier=TEAM\nTimestamp=fixture\n<plist><dict><key>com.apple.security.cs.allow-jit</key><true/></dict></plist>";
  const options = {
    requireDeveloperId: true,
    requireStapledTicket: false,
    requiredEntitlements: ["com.apple.security.cs.allow-jit"],
  };
  assert.deepEqual(macosSignatureErrors(output, options), []);
  assert.ok(macosSignatureErrors(output.replace("<true/>", "<false/>"), options).length);
  assert.ok(
    macosSignatureErrors(output.replace("flags=0x10000(runtime)", "flags=0x0(none)"), options)
      .length,
  );
});
