import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

async function line(path) {
  if (!(await lstat(path)).isFile()) throw new Error("repository_metadata_unavailable");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const data = Buffer.alloc(8193);
    const { bytesRead } = await file.read(data, 0, data.length, 0);
    if (bytesRead > 8192) throw new Error("repository_metadata_unavailable");
    const value = new TextDecoder("utf-8", { fatal: true })
      .decode(data.subarray(0, bytesRead))
      .replace(/\r?\n$/, "");
    if (!value || /[\0\r\n]/.test(value)) throw new Error("repository_metadata_unavailable");
    return value;
  } finally {
    await file.close();
  }
}

/** 選択済みの作業場所を観測し、worktree は作成・強制しない。
 * Git の子プロセスやフックを実行せず、設定や作業ファイルを評価しない。 */
export async function workspaceRepository(directory) {
  const cwd = await realpath(directory);
  for (let root = cwd; ; root = dirname(root)) {
    const marker = join(root, ".git");
    let stat;
    try {
      stat = await lstat(marker);
    } catch (error) {
      if (error.code !== "ENOENT")
        return { kind: "unverified", root, linkedWorktreeVerified: false, branch: null };
    }
    if (stat) {
      let gitdir;
      let kind = "unverified";
      let linkedWorktreeVerified = false;
      try {
        if (stat.isDirectory()) {
          gitdir = await realpath(marker);
          kind = "primary";
        } else {
          const value = await line(marker);
          if (!value.startsWith("gitdir: ")) throw new Error("repository_metadata_unavailable");
          const selected = resolve(root, value.slice(8));
          if (!(await lstat(selected)).isDirectory())
            throw new Error("repository_metadata_unavailable");
          gitdir = await realpath(selected);
          try {
            const common = await realpath(resolve(gitdir, await line(join(gitdir, "commondir"))));
            const registrations = join(common, "worktrees");
            const backpointer = resolve(gitdir, await line(join(gitdir, "gitdir")));
            linkedWorktreeVerified =
              (await lstat(registrations)).isDirectory() &&
              dirname(gitdir) === registrations &&
              (await lstat(backpointer)).isFile() &&
              (await realpath(backpointer)) === marker &&
              (await lstat(join(common, "objects"))).isDirectory();
            kind = linkedWorktreeVerified ? "linked" : "unverified";
          } catch {
            // 別置きの主 gitdir や submodule を、登録を検証した linked worktree
            // と誤認しない。
            kind = "external-gitdir";
          }
        }
        const head = await line(join(gitdir, "HEAD"));
        return {
          kind,
          root,
          linkedWorktreeVerified,
          branch: head.startsWith("ref: refs/heads/") ? head.slice(16) : null,
          detached: !head.startsWith("ref: "),
        };
      } catch {
        return { kind: "unverified", root, linkedWorktreeVerified: false, branch: null };
      }
    }
    if (dirname(root) === root)
      return { kind: "none", root: null, linkedWorktreeVerified: false, branch: null };
  }
}
