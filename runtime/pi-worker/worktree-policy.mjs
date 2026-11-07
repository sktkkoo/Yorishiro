import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

const MAX_MARKER_BYTES = 8192;
const fail = () => {
  throw new Error("worktree_required");
};

async function marker(directory) {
  for (let current = directory; ; current = dirname(current)) {
    const path = join(current, ".git");
    try {
      await lstat(path);
      return path;
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ENOTDIR") fail();
    }
    if (dirname(current) === current) return null;
  }
}

async function regularText(path) {
  if (!(await lstat(path)).isFile()) fail();
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if ((await file.stat()).size > MAX_MARKER_BYTES) fail();
    const buffer = Buffer.alloc(MAX_MARKER_BYTES + 1);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_MARKER_BYTES) fail();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    const line = text.replace(/\r?\n$/, "");
    if (!line || /[\r\n\0]/.test(line)) fail();
    return line;
  } finally {
    await file.close();
  }
}

async function directory(path) {
  if (!(await lstat(path)).isDirectory()) fail();
}

async function registeredLinkedMarker(path) {
  // Primary checkouts have a .git directory. Separate primary gitdirs and
  // submodules have a file too, but lack the linked-worktree registration.
  const value = await regularText(path);
  if (!value.startsWith("gitdir: ")) fail();
  const gitdirPath = resolve(dirname(path), value.slice(8));
  await directory(gitdirPath); // Reject a symlink standing in for registration.
  const gitdir = await realpath(gitdirPath);
  const common = await realpath(resolve(gitdir, await regularText(join(gitdir, "commondir"))));
  await directory(common);
  const registrations = join(common, "worktrees");
  await directory(registrations);
  if (dirname(gitdir) !== registrations) fail();
  // Both references must lead back to this exact canonical .git file. Merely
  // copying another checkout's marker cannot borrow its registration.
  const backpointer = resolve(gitdir, await regularText(join(gitdir, "gitdir")));
  if (!(await lstat(backpointer)).isFile() || (await realpath(backpointer)) !== path) fail();
  await regularText(join(gitdir, "HEAD"));
  await regularText(join(common, "HEAD"));
  await directory(join(common, "objects"));
}

/** Managed host constraint; no Git process, config changes, or permission widening.
 * Non-Git notes remain allowed. A known Git workspace cannot become unrestricted
 * by deleting its marker while an operation is staged. */
export async function createWorktreeWritePolicy(workspace) {
  const knownDestinations = new Set();
  let originalMarker;
  try {
    originalMarker = await marker(workspace);
  } catch {
    originalMarker = false;
  }
  return async (destinationDirectory = workspace) => {
    try {
      const currentWorkspace = await realpath(workspace);
      const workspaceMarker = await marker(currentWorkspace);
      if (originalMarker === false || (originalMarker && workspaceMarker !== originalMarker))
        fail();
      if (workspaceMarker) await registeredLinkedMarker(workspaceMarker);
      const destinationMarker = await marker(destinationDirectory);
      if (destinationMarker && destinationMarker !== workspaceMarker)
        await registeredLinkedMarker(destinationMarker);
      for (const known of knownDestinations) {
        const root = dirname(known);
        if (
          known !== destinationMarker &&
          known !== workspaceMarker &&
          (destinationDirectory === root || destinationDirectory.startsWith(root + sep))
        )
          await registeredLinkedMarker(known);
      }
      if (destinationMarker) knownDestinations.add(destinationMarker);
    } catch {
      fail();
    }
  };
}
