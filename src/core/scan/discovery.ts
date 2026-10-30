import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export async function discoverRepos(root: string, maxDepth: number): Promise<string[]> {
  const repos: string[] = [];
  const skipped = new Set([
    ".git",
    "node_modules",
    "dist",
    "build",
    "target",
    ".next",
    ".cache",
    ".Trash",
  ]);

  async function visit(directory: string, depth: number): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      (error: NodeJS.ErrnoException) => {
        if (depth > 0 && ["EACCES", "EPERM", "ENOENT"].includes(error.code ?? "")) return [];
        throw error;
      },
    );
    if (
      depth + 1 <= maxDepth &&
      entries.some((entry) => entry.name === ".git" && entry.isDirectory())
    ) {
      repos.push(directory);
      return;
    }
    if (depth + 2 > maxDepth) return;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!entry.isDirectory() || skipped.has(entry.name)) continue;
      await visit(join(directory, entry.name), depth + 1);
    }
  }

  await visit(root, 0);
  return repos.sort();
}

export interface LinkedWorktrees {
  count: number;
  /** Folders of the worktrees whose `gitdir` record could be read. */
  paths: string[];
  /** Names of the records whose `gitdir` could not be read. */
  unread: string[];
}

/** Read the linked worktrees Git records in `.git/worktrees`, without running Git. */
export async function readLinkedWorktrees(repo: string): Promise<LinkedWorktrees | null> {
  const records = join(repo, ".git", "worktrees");
  let names: string[];
  try {
    const entries = await readdir(records, { withFileTypes: true });
    names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { count: 0, paths: [], unread: [] }
      : null;
  }
  const paths = await Promise.all(
    names.map((name) =>
      readFile(join(records, name, "gitdir"), "utf8").then(
        // Git writes a relative path, against the record's folder, under worktree.useRelativePaths.
        (gitdir) => dirname(resolve(join(records, name), gitdir.trim())),
        () => null,
      ),
    ),
  );
  return {
    count: names.length,
    paths: paths.filter((path) => path !== null),
    unread: names.filter((_, index) => paths[index] === null),
  };
}

/**
 * When Git created the worktree, as an ISO time, or null when it can't be read. Uses the birth time of its
 * folder under `.git/worktrees`, whose mtime moves with every commit and checkout.
 */
export async function readCreatedAt(worktree: string): Promise<string | null> {
  try {
    const link = await readFile(join(worktree, ".git"), "utf8");
    const gitdir = /^gitdir: (.+)$/m.exec(link)?.[1]?.trim();
    if (!gitdir) return null;
    const { birthtimeMs } = await stat(resolve(worktree, gitdir));
    return birthtimeMs > 0 ? new Date(birthtimeMs).toISOString() : null;
  } catch {
    return null;
  }
}
