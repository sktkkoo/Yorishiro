import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createWorkspaceTools } from "./workspace-tools.mjs";

const permissions = { read: true, write: true, commands: [] };
async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "yorishiro-worktree-policy-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const git = (args, cwd = base) =>
    execFileSync("git", args, {
      cwd,
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: join(base, "no-global-config"),
        GIT_TERMINAL_PROMPT: "0",
      },
      stdio: "pipe",
    });
  const primary = join(base, "primary");
  const linked = join(base, "linked");
  git(["init", "-b", "main", primary]);
  await mkdir(join(primary, "src"));
  await writeFile(join(primary, "src", "task.txt"), "original task\n");
  git(["add", "."], primary);
  git(
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "fixture",
    ],
    primary,
  );
  git(["worktree", "add", "-b", "worker", linked], primary);
  const gitdir = (await readFile(join(linked, ".git"), "utf8")).trim().slice(8);
  return { base, primary, linked, gitdir, git };
}

async function tools(cwd, options = {}) {
  const registered = await createWorkspaceTools(cwd, permissions, { managed: true, ...options });
  return (name, args, signal) =>
    registered.find((tool) => tool.name === name).execute(args, {}, { abortSignal: signal });
}
const required = (operation) => assert.rejects(operation, { message: "worktree_required" });

test("managed primary checkout writes and edits fail without creating directories or files", async (t) => {
  const f = await fixture(t);
  const call = await tools(join(f.primary, "src"));
  const before = await readdir(join(f.primary, "src"));
  await required(
    call("write_file", { path: "missing/deep/new.txt", content: "must not be published" }),
  );
  await required(call("edit_file", { path: "task.txt", oldText: "original", newText: "changed" }));
  assert.deepEqual(await readdir(join(f.primary, "src")), before);
  assert.equal(await readFile(join(f.primary, "src", "task.txt"), "utf8"), "original task\n");
  assert.equal((await call("read_file", { path: "task.txt" })).output[0].text, "original task\n");
});

test("registered linked worktrees and their subdirectories allow bounded writes without runtime Git", async (t) => {
  const f = await fixture(t);
  const call = await tools(join(f.linked, "src"));
  const previousPath = process.env.PATH;
  process.env.PATH = "";
  try {
    await call("write_file", { path: "new/deep/result.txt", content: "linked result😀" });
    await call("edit_file", { path: "task.txt", oldText: "original", newText: "reviewed" });
    assert.equal(
      (await call("read_file", { path: "new/deep/result.txt" })).output[0].text,
      "linked result😀",
    );
    assert.equal(await readFile(join(f.linked, "src", "task.txt"), "utf8"), "reviewed task\n");
    assert.equal(await readFile(join(f.primary, "src", "task.txt"), "utf8"), "original task\n");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

test("read-only primary access, explicit non-Git notes and legacy writes retain their existing behavior", async (t) => {
  const f = await fixture(t);
  const readOnly = await createWorkspaceTools(
    f.primary,
    { ...permissions, write: false },
    { managed: true },
  );
  assert.deepEqual(
    readOnly.map(({ name }) => name),
    ["read_file"],
  );
  assert.equal(
    (await readOnly[0].execute({ path: "src/task.txt" }, {}, {})).output[0].text,
    "original task\n",
  );
  const notes = join(f.base, "notes");
  await mkdir(notes);
  await (await tools(notes))("write_file", { path: "daily/note.md", content: "Explicit note" });
  assert.equal(await readFile(join(notes, "daily/note.md"), "utf8"), "Explicit note");
  await (await tools(f.primary, { managed: false }))("write_file", {
    path: "legacy.txt",
    content: "Legacy permission",
  });
  assert.equal(await readFile(join(f.primary, "legacy.txt"), "utf8"), "Legacy permission");
  const parentGrant = await tools(f.base);
  await required(
    parentGrant("write_file", {
      path: "primary/nested/new.txt",
      content: "No primary writes through HOME",
    }),
  );
  await assert.rejects(readFile(join(f.primary, "nested", "new.txt")), { code: "ENOENT" });
});

for (const corruption of [
  "borrowed-marker",
  "unregistered",
  "marker-symlink",
  "registration-symlink",
  "commondir-symlink",
  "backpointer-mismatch",
]) {
  test(`managed writes reject ${corruption} metadata with a fixed redacted error`, async (t) => {
    const f = await fixture(t);
    let workspace = f.linked;
    if (corruption === "borrowed-marker" || corruption === "unregistered") {
      workspace = join(f.base, "spoofed");
      await mkdir(workspace);
      if (corruption === "borrowed-marker") {
        await writeFile(join(workspace, ".git"), await readFile(join(f.linked, ".git")));
      } else {
        const unregistered = join(f.base, "unregistered-gitdir");
        await mkdir(unregistered);
        await writeFile(join(unregistered, "commondir"), join(f.primary, ".git"));
        await writeFile(join(unregistered, "gitdir"), join(workspace, ".git"));
        await writeFile(join(unregistered, "HEAD"), "ref: refs/heads/worker\n");
        await writeFile(join(workspace, ".git"), `gitdir: ${unregistered}\n`);
      }
    } else if (corruption === "marker-symlink") {
      const moved = join(f.base, "saved-marker");
      await rename(join(workspace, ".git"), moved);
      await symlink(moved, join(workspace, ".git"));
    } else if (corruption === "registration-symlink") {
      const moved = join(f.base, "saved-registration");
      await rename(f.gitdir, moved);
      await symlink(moved, f.gitdir, "dir");
    } else if (corruption === "commondir-symlink") {
      await rename(join(f.gitdir, "commondir"), join(f.gitdir, "actual-commondir"));
      await symlink("actual-commondir", join(f.gitdir, "commondir"));
    } else {
      await writeFile(join(f.gitdir, "gitdir"), join(f.primary, ".git"));
    }
    const call = await tools(workspace);
    await required(
      call("write_file", { path: "new/deep/result.txt", content: "SECRET must not leak" }),
    );
    await assert.rejects(readFile(join(workspace, "new", "deep", "result.txt")), {
      code: "ENOENT",
    });
    assert.equal(
      (await readdir(workspace)).some((name) => name.startsWith(".yori-write-")),
      false,
    );
  });
}

test("separate primary gitdirs do not masquerade as linked worktrees", async (t) => {
  const f = await fixture(t);
  const separate = join(f.base, "separate-primary");
  f.git(["init", "--separate-git-dir", join(f.base, "separate-metadata"), separate]);
  await required((await tools(separate))("write_file", { path: "new.txt", content: "blocked" }));
});

test("removing a known Git workspace marker cannot turn it into an unrestricted notes grant", async (t) => {
  const f = await fixture(t);
  const call = await tools(f.linked);
  await rm(join(f.linked, ".git"));
  await required(call("write_file", { path: "new.txt", content: "blocked" }));
  await assert.rejects(readFile(join(f.linked, "new.txt")), { code: "ENOENT" });
});

test("a nested linked checkout cannot lose its marker between validation and publication", async (t) => {
  const f = await fixture(t);
  const call = await tools(f.base);
  let revoked = false;
  const signal = {
    get aborted() {
      if (!revoked && readdirSync(f.linked).some((name) => name.startsWith(".yori-write-"))) {
        unlinkSync(join(f.linked, ".git"));
        revoked = true;
      }
      return false;
    },
  };
  await required(call("write_file", { path: "linked/new.txt", content: "blocked" }, signal));
  assert.equal(revoked, true);
  await assert.rejects(readFile(join(f.linked, "new.txt")), { code: "ENOENT" });
  assert.equal(
    (await readdir(f.linked)).some((name) => name.startsWith(".yori-write-")),
    false,
  );
});

for (const operation of ["write_file", "edit_file"]) {
  test(`${operation} revalidates registration immediately before publication and removes its staged file`, async (t) => {
    const f = await fixture(t);
    const call = await tools(join(f.linked, "src"));
    let revoked = false;
    const signal = {
      get aborted() {
        if (
          !revoked &&
          readdirSync(join(f.linked, "src")).some((name) => name.startsWith(".yori-write-"))
        ) {
          unlinkSync(join(f.gitdir, "commondir"));
          revoked = true;
        }
        return false;
      },
    };
    const args =
      operation === "write_file"
        ? { path: "task.txt", content: "replacement", expectedContent: "original task\n" }
        : { path: "task.txt", oldText: "original", newText: "replacement" };
    await required(call(operation, args, signal));
    assert.equal(revoked, true);
    assert.equal(await readFile(join(f.linked, "src", "task.txt"), "utf8"), "original task\n");
    assert.deepEqual(await readdir(join(f.linked, "src")), ["task.txt"]);
  });
}

test("linked permission still excludes Git, provider credentials and native preferences", async (t) => {
  const f = await fixture(t);
  const protectedPaths = [join(f.linked, "credentials"), join(f.linked, "native-preferences")];
  const call = await tools(f.linked, { protectedPaths });
  await assert.rejects(call("write_file", { path: ".git", content: "corrupt" }), /Git metadata/);
  for (const path of ["credentials/auth.json", "native-preferences/settings.json"]) {
    await assert.rejects(call("write_file", { path, content: "corrupt" }), /credential storage/);
  }
  assert.equal(dirname(f.gitdir), join(f.primary, ".git", "worktrees"));
});
